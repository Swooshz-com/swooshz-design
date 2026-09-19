#!/usr/bin/env python3
"""Offline F/C/H/S regression gate for the amended S8 Blender writer contract.

The gate uses a deliberately small Blender-shaped test double so the defect
families can run on a clean Python installation. The production writer still
performs the same proofs against the pinned Blender runtime and private
exporter; this harness does not replace that runtime qualification.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import inspect
import pathlib
import sys
import types
from typing import Any, Callable


ROOT = pathlib.Path(__file__).resolve().parents[2]
WRITER_PATH = ROOT / "blender" / "s8-fbx-writer" / "writer.py"


class FakeMatrix:
    def __init__(self, values: tuple[tuple[float, ...], ...] | None = None):
        self.values = values or tuple(tuple(1.0 if row == column else 0.0 for column in range(4)) for row in range(4))

    @classmethod
    def Identity(cls, size: int) -> "FakeMatrix":
        if size != 4:
            raise ValueError("only 4x4 matrices are supported")
        return cls()

    def __eq__(self, other: object) -> bool:
        return isinstance(other, FakeMatrix) and self.values == other.values

    def __getitem__(self, row: int) -> tuple[float, ...]:
        return self.values[row]


class FakeCollection(list):
    def __init__(self, factory: Callable[..., Any] | None = None):
        super().__init__()
        self.factory = factory

    def new(self, *args: Any) -> Any:
        if self.factory is None:
            raise RuntimeError("fake collection has no factory")
        item = self.factory(*args)
        self.append(item)
        return item

    def remove(self, item: Any, do_unlink: bool = False) -> None:
        super().remove(item)


class FakePolygon:
    def __init__(self, vertices: tuple[int, ...]):
        self.vertices = vertices
        self.use_smooth = False


class FakeMesh:
    def __init__(self, name: str):
        self.name = name
        self.polygons: list[FakePolygon] = []
        self.materials: list[Any] = []

    def from_pydata(self, vertices: list[tuple[float, ...]], _edges: list[Any], faces: list[tuple[int, ...]]) -> None:
        self.vertices = vertices
        self.faces = faces
        self.polygons = [FakePolygon(face) for face in faces]

    def update(self, calc_edges: bool = False) -> None:
        self.calc_edges = calc_edges

    def normals_split_custom_set(self, normals: list[tuple[float, ...]]) -> None:
        self.normals = normals


class FakeMaterial:
    def __init__(self, name: str):
        self.name = name
        self.use_nodes = False
        self.diffuse_color = None
        self.specular_intensity = None
        self.roughness = None


class FakeObject:
    def __init__(self, name: str, data: Any):
        self.name = name
        self.data = data
        self.type = "EMPTY" if data is None else "MESH"
        self.parent = None
        self.location = (0.0, 0.0, 0.0)
        self.rotation_mode = "XYZ"
        self.rotation_euler = (0.0, 0.0, 0.0)
        self.scale = (1.0, 1.0, 1.0)
        self.delta_location = (0.0, 0.0, 0.0)
        self.delta_rotation_euler = (0.0, 0.0, 0.0)
        self.delta_scale = (1.0, 1.0, 1.0)
        self.matrix_parent_inverse = FakeMatrix.Identity(4)
        self.hide_viewport = False
        self.hide_render = False
        self.hide_select = False
        self.instance_type = "NONE"
        self.instance_collection = None
        self.library = None
        self.override_library = None
        self.modifiers: list[Any] = []
        self.constraints: list[Any] = []
        self.particle_systems: list[Any] = []
        self.original = self
        self.custom: dict[str, Any] = {}
        self.selected = False

    def __setitem__(self, key: str, value: Any) -> None:
        self.custom[key] = value

    def keys(self):
        return self.custom.keys()


class FakeObjectCollection(FakeCollection):
    def __init__(self):
        super().__init__(lambda name, data: FakeObject(name, data))


class FakeLinkCollection:
    def __init__(self, objects: FakeObjectCollection):
        self.objects = objects

    def link(self, obj: FakeObject) -> None:
        if obj not in self.objects:
            self.objects.append(obj)


class FakeWorld:
    def __init__(self) -> None:
        self.data = types.SimpleNamespace()
        self.data.objects = FakeObjectCollection()
        self.data.meshes = FakeCollection(lambda name: FakeMesh(name))
        self.data.materials = FakeCollection(lambda name: FakeMaterial(name))
        self.data.curves = FakeCollection()
        self.data.cameras = FakeCollection()
        self.data.lights = FakeCollection()
        self.scene = types.SimpleNamespace()
        self.scene.collection = types.SimpleNamespace(objects=FakeLinkCollection(self.data.objects))
        self.scene.objects = self.data.objects
        self.scene.unit_settings = types.SimpleNamespace()
        self.view_layer = types.SimpleNamespace(objects=self.data.objects, active=None)
        self.graph = None
        self.context = types.SimpleNamespace(
            scene=self.scene,
            view_layer=self.view_layer,
            evaluated_depsgraph_get=self.evaluated_depsgraph_get,
        )
        self.bpy = types.SimpleNamespace(data=self.data, context=self.context)

    def evaluated_depsgraph_get(self) -> Any:
        if self.graph is None:
            self.graph = FakeDepsgraph(self.data.objects)
        return self.graph

    def new_graph(self) -> Any:
        self.graph = FakeDepsgraph(self.data.objects)
        return self.graph


class FakeDepsgraph:
    def __init__(self, objects: FakeObjectCollection):
        self.view_layer = types.SimpleNamespace(objects=objects)
        self.objects = objects
        self.object_instances = [types.SimpleNamespace(object=obj, is_instance=False) for obj in objects]


class SaveSingleSpy:
    def __init__(self, result: set[str] | None = None):
        self.result = result or {"FINISHED"}
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        parameters = [
            inspect.Parameter("operator", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("scene", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("depsgraph", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        ]
        for name in sorted(WRITER_DIRECT_KWARGS):
            if name == "filepath":
                parameters.append(inspect.Parameter(name, inspect.Parameter.POSITIONAL_OR_KEYWORD, default=""))
            else:
                parameters.append(inspect.Parameter(name, inspect.Parameter.POSITIONAL_OR_KEYWORD, default=None))
        self.__signature__ = inspect.Signature(parameters)

    def __call__(self, *args: Any, **kwargs: Any) -> set[str]:
        self.calls.append((args, kwargs))
        return self.result


class FakeExporter:
    def __init__(self, duplicate: bool = False, result: set[str] | None = None):
        self.save_single = SaveSingleSpy(result)

        duplicate_flag = duplicate

        class Wrapper:
            def __init__(self, _obj: Any):
                self.obj = _obj

            def dupli_list_gen(self, _depsgraph: Any):
                return [object()] if duplicate_flag else []

        self.ObjectWrapper = Wrapper


def load_writer() -> Any:
    bpy_module = types.ModuleType("bpy")
    io_scene_fbx_module = types.ModuleType("io_scene_fbx")
    io_scene_fbx_module.bl_info = {"version": (5, 15, 0)}
    mathutils_module = types.ModuleType("mathutils")
    mathutils_module.Matrix = FakeMatrix
    sys.modules["bpy"] = bpy_module
    sys.modules["io_scene_fbx"] = io_scene_fbx_module
    sys.modules["mathutils"] = mathutils_module
    spec = importlib.util.spec_from_file_location("s8_writer_contract_regression_target", WRITER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("writer module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


writer = load_writer()
WRITER_DIRECT_KWARGS = set(writer.DIRECT_EXPORT_KWARG_NAMES)


def install_world(world: FakeWorld) -> None:
    writer.bpy = world.bpy
    writer.Matrix = FakeMatrix


def source_stamp() -> dict[str, str]:
    return {
        "projectId": "project-1",
        "revisionId": "revision-1",
        "revisionHash": "a" * 64,
        "sourceS5Fingerprint": "b" * 64,
        "s6ValidationReceiptId": "receipt-1",
        "s6ValidationHash": "c" * 64,
        "s6HandoffDigest": "d" * 64,
        "s7ArtifactId": "artifact-1",
        "s7ArtifactHash": "e" * 64,
        "s7ReadbackHash": "f" * 64,
    }


def object_record(object_id: str, parent_id: str | None, parent_name: str) -> dict[str, Any]:
    name = writer._stable_object_name(0, object_id)
    matrix = [
        writer.UNIT_SCALE, 0, 0, 0,
        0, writer.UNIT_SCALE, 0, 0,
        0, 0, writer.UNIT_SCALE, 0,
        0, 0, 0, writer.UNIT_SCALE,
    ]
    return {
        "name": name,
        "objectId": object_id,
        "identityKey": f"identity-{object_id}",
        "parentName": parent_name,
        "sourceObjectId": object_id,
        "sourceParentObjectId": parent_id,
        "localTranslationTicks": [0, 0, 0],
        "sourceEulerMicrodegrees": [0, 0, 0],
        "unitScaleTicks": [writer.UNIT_SCALE, writer.UNIT_SCALE, writer.UNIT_SCALE],
        "nodeKind": "mesh",
        "matrixTicks": matrix,
        "transformDigest": hashlib.sha256(object_id.encode("utf-8")).hexdigest(),
        "verticesTicks": [[0, 0, 0], [writer.POSITION_SCALE, 0, 0], [0, writer.POSITION_SCALE, 0]],
        "triangles": [[0, 1, 2]],
        "cornerNormalsTicks": [[0, 0, writer.UNIT_SCALE]] * 3,
        "materialName": None,
        "degradationCodes": [],
        "geometryState": "exact",
        "roundSegments": None,
        "analyticSagittaTicks": None,
    }


def make_payload(object_ids: list[str], parents: dict[str, str | None] | None = None, order: list[str] | None = None) -> dict[str, Any]:
    parents = parents or {}
    ordered_ids = order or list(object_ids)
    by_id = {object_id: object_id for object_id in object_ids}
    sorted_ids = sorted(object_ids, key=lambda value: value.encode("utf-8"))
    names = {object_id: writer._stable_object_name(index, object_id) for index, object_id in enumerate(sorted_ids)}
    records = []
    for object_id in ordered_ids:
        parent_id = parents.get(object_id)
        records.append(object_record(object_id, parent_id, "SWZ_ROOT" if parent_id is None else names.get(parent_id, "UNKNOWN")))
        records[-1]["name"] = names[object_id]
    return {
        "schemaVersion": "swooshz-fbx-writer-input-v1",
        "profile": "swooshz-fbx-static-mesh-v1",
        "source": source_stamp(),
        "scene": {"frontAxis": "-Y", "rightAxis": "+X", "rootName": "SWZ_ROOT", "units": "millimetres", "upAxis": "+Z"},
        "materials": [],
        "objects": records,
    }


def make_state(object_ids: list[str] | None = None, parents: dict[str, str | None] | None = None, order: list[str] | None = None):
    world = FakeWorld()
    install_world(world)
    payload = make_payload(object_ids or ["obj-a"], parents, order)
    admission = writer.admit_payload(payload)
    state = writer.construct_scene(admission)
    writer.audit_original_scene(admission, state)
    graph = world.new_graph()
    writer.audit_evaluated_membership(admission, state, graph)
    return world, payload, admission, state, graph


def expect_error(code: str, action: Callable[[], Any]) -> None:
    try:
        action()
    except RuntimeError as error:
        if str(error) != code:
            raise AssertionError(f"expected {code}, received {error}") from error
        return
    raise AssertionError(f"expected {code}, action succeeded")


def test_f01() -> None:
    world = FakeWorld()
    install_world(world)
    world.data.filepath = ""
    writer.require_factory_filepath()


def test_f02() -> None:
    world = FakeWorld()
    install_world(world)
    world.data.filepath = "C:/must-not-be-open.blend"
    expect_error("S8_BLENDER_FILEPATH_NOT_EMPTY", writer.require_factory_filepath)
    source = WRITER_PATH.read_text(encoding="utf-8")
    assert "bpy.data.filepath =" not in source


def test_c01() -> None:
    world, _payload, admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    assert isinstance(context, tuple) and context
    exporter = FakeExporter()
    writer.assert_save_single_signature(exporter)
    writer.assert_membership(admission, state, graph, context)
    writer.export_fbx(pathlib.Path("artifact.fbx"), exporter, state["scene"], graph, context, state["transform_table"])
    assert exporter.save_single.calls[0][1]["context_objects"] is context
    assert world.data.objects


def test_c02() -> None:
    _world, _payload, admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    writer.assert_membership(admission, state, graph, context)
    assert [obj.name for obj in context] == sorted(state["objects"])
    assert "SWZ_ROOT" in {obj.name for obj in context}


def test_c03() -> None:
    _world, _payload, admission, state, graph = make_state(["obj-a", "obj-b"], order=["obj-b", "obj-a"])
    reverse_objects = {name: state["objects"][name] for name in reversed(list(state["objects"]))}
    context = writer.build_context_objects(reverse_objects)
    assert [obj.name for obj in context] == sorted(reverse_objects)
    writer.assert_membership(admission, state, graph, context)


def test_c04() -> None:
    world, _payload, admission, state, graph = make_state(["obj-a", "obj-b"])
    for obj in state["objects"].values():
        obj.selected = True
        obj.hide_viewport = True
    world.view_layer.active = state["objects"]["SWZ_ROOT"]
    context = writer.build_context_objects(state["objects"])
    assert [obj.name for obj in context] == sorted(state["objects"])
    writer.assert_membership(admission, state, graph, context)


def test_c05() -> None:
    _world, _payload, admission, state, graph = make_state(["obj-a", "obj-b"])
    context = writer.build_context_objects(state["objects"])
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.assert_membership(admission, state, graph, context[:-1]))


def test_c06() -> None:
    world, _payload, admission, state, graph = make_state()
    world.data.objects.append(FakeObject("SWZ_EXTRA", FakeMesh("extra")))
    context = writer.build_context_objects(state["objects"])
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.assert_membership(admission, state, graph, context))


def test_c07() -> None:
    _world, _payload, admission, state, graph = make_state()
    state["transform_table"].pop("SWZ_ROOT")
    context = writer.build_context_objects(state["objects"])
    expect_error("S8_EXPORT_TABLE_MISMATCH", lambda: writer.assert_membership(admission, state, graph, context))


def test_c08() -> None:
    _world, _payload, admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    expect_error("S8_EXPORT_INSTANCE_FORBIDDEN", lambda: writer.audit_exporter_discovery(FakeExporter(duplicate=True), context, graph))


def test_c09() -> None:
    _world, _payload, admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    exporter = FakeExporter()
    writer.assert_save_single_signature(exporter)
    writer.assert_membership(admission, state, graph, context)
    writer.export_fbx(pathlib.Path("artifact.fbx"), exporter, state["scene"], graph, context, state["transform_table"])
    assert len(exporter.save_single.calls) == 1
    assert exporter.save_single.calls[0][1]["object_types"] == {"EMPTY", "MESH"}


def test_h01() -> None:
    _world, _payload, admission, state, graph = make_state()
    assert admission["expected_parent_by_name"][next(name for name in admission["physical_names"])] == "SWZ_ROOT"
    writer.audit_hierarchy(admission, state["objects"])
    assert state["objects"][next(name for name in admission["physical_names"])].parent is state["objects"]["SWZ_ROOT"]


def test_h02() -> None:
    world, _payload, admission, state, graph = make_state(["obj-a", "obj-b"], {"obj-a": None, "obj-b": "obj-a"})
    writer.audit_hierarchy(admission, state["objects"])
    child_name = writer._stable_object_name(1, "obj-b")
    parent_name = writer._stable_object_name(0, "obj-a")
    assert state["objects"][child_name].parent is state["objects"][parent_name]
    writer.audit_evaluated_membership(admission, state, graph)
    assert world.data.objects


def test_h03() -> None:
    payload = make_payload(["obj-a"])
    payload["objects"][0]["sourceParentObjectId"] = "missing"
    expect_error("S8_HIERARCHY_INVALID", lambda: writer.admit_payload(payload))


def test_h04() -> None:
    payload = make_payload(["obj-a"])
    payload["objects"][0]["parentName"] = "WRONG_PARENT"
    expect_error("S8_HIERARCHY_INVALID", lambda: writer.admit_payload(payload))


def test_h05() -> None:
    _world, _payload, admission, state, _graph = make_state(["obj-a", "obj-b"], {"obj-a": None, "obj-b": "obj-a"})
    child_name = writer._stable_object_name(1, "obj-b")
    state["objects"][child_name].parent = None
    expect_error("S8_HIERARCHY_INVALID", lambda: writer.audit_hierarchy(admission, state["objects"]))


def test_h06() -> None:
    _world, _payload, admission, state, _graph = make_state(["obj-a", "obj-b"], {"obj-a": None, "obj-b": "obj-a"})
    child_name = writer._stable_object_name(1, "obj-b")
    state["objects"][child_name].parent = FakeObject("SWZ_HELPER", None)
    expect_error("S8_HIERARCHY_INVALID", lambda: writer.audit_hierarchy(admission, state["objects"]))


def test_h07() -> None:
    payload = make_payload(["obj-a", "obj-b"], {"obj-a": "obj-b", "obj-b": "obj-a"})
    expect_error("S8_HIERARCHY_CYCLE", lambda: writer.admit_payload(payload))


def test_h08() -> None:
    duplicate_root = make_payload(["obj-a"])
    duplicate_root["objects"][0]["name"] = "SWZ_ROOT"
    expect_error("S8_OBJECT_INVALID", lambda: writer.admit_payload(duplicate_root))

    _world, _payload, admission, state, _graph = make_state()
    state["objects"].pop("SWZ_ROOT")
    expect_error("S8_HIERARCHY_INVALID", lambda: writer.audit_hierarchy(admission, state["objects"]))

    world, _payload, admission, state, graph = make_state()
    world.data.objects.append(FakeObject("SWZ_ROOT.001", None))
    context = writer.build_context_objects(state["objects"])
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.assert_membership(admission, state, graph, context))


def test_h09() -> None:
    _world, _payload, admission, state, graph = make_state(["obj-a", "obj-b"])
    context = writer.build_context_objects(state["objects"])
    writer.assert_membership(admission, state, graph, context)
    state["transform_table"].pop("SWZ_ROOT")
    expect_error("S8_EXPORT_TABLE_MISMATCH", lambda: writer.assert_membership(admission, state, graph, context))

    _world, _payload, admission, state, graph = make_state()
    state["transform_table"]["SWZ_EXTRA"] = state["transform_table"]["SWZ_ROOT"]
    context = writer.build_context_objects(state["objects"])
    expect_error("S8_EXPORT_TABLE_MISMATCH", lambda: writer.assert_membership(admission, state, graph, context))


def test_s01() -> None:
    _world, _payload, _admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    exporter = FakeExporter()
    parameter_names = writer.assert_save_single_signature(exporter)
    assert WRITER_DIRECT_KWARGS.issubset(set(parameter_names))
    writer.export_fbx(pathlib.Path("artifact.fbx"), exporter, state["scene"], graph, context, state["transform_table"])
    kwargs = exporter.save_single.calls[0][1]
    assert set(kwargs) == WRITER_DIRECT_KWARGS
    assert "use_space_transform" not in kwargs and "batch_mode" not in kwargs
    assert kwargs["global_scale"] == 1.0
    assert kwargs["apply_unit_scale"] is True
    assert kwargs["object_types"] == {"EMPTY", "MESH"}
    assert kwargs["use_custom_props"] is True


def test_s02() -> None:
    _world, _payload, _admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    exporter = FakeExporter()
    writer.export_fbx(pathlib.Path("artifact.fbx"), exporter, state["scene"], graph, context, state["transform_table"])
    args, kwargs = exporter.save_single.calls[0]
    assert args[2] is graph
    assert kwargs["global_matrix"] == FakeMatrix.Identity(4)
    assert kwargs["context_objects"] is context
    assert kwargs["s8_transform_table"] is state["transform_table"]


def test_s03() -> None:
    _world, _payload, _admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    expect_error(
        "S8_EXPORT_FAILED",
        lambda: writer.export_fbx(pathlib.Path("artifact.fbx"), FakeExporter(result={"CANCELLED"}), state["scene"], graph, context, state["transform_table"]),
    )


def test_s04() -> None:
    source = WRITER_PATH.read_text(encoding="utf-8")
    assert "bpy.ops.export_scene.fbx" not in source
    _world, _payload, _admission, state, graph = make_state()
    context = writer.build_context_objects(state["objects"])
    exporter = FakeExporter()
    writer.export_fbx(pathlib.Path("artifact.fbx"), exporter, state["scene"], graph, context, state["transform_table"])
    assert len(exporter.save_single.calls) == 1


CASES: list[tuple[str, Callable[[], None]]] = [
    ("F01", test_f01),
    ("F02", test_f02),
    ("C01", test_c01),
    ("C02", test_c02),
    ("C03", test_c03),
    ("C04", test_c04),
    ("C05", test_c05),
    ("C06", test_c06),
    ("C07", test_c07),
    ("C08", test_c08),
    ("C09", test_c09),
    ("H01", test_h01),
    ("H02", test_h02),
    ("H03", test_h03),
    ("H04", test_h04),
    ("H05", test_h05),
    ("H06", test_h06),
    ("H07", test_h07),
    ("H08", test_h08),
    ("H09", test_h09),
    ("S01", test_s01),
    ("S02", test_s02),
    ("S03", test_s03),
    ("S04", test_s04),
]


def main() -> int:
    ast.parse(WRITER_PATH.read_text(encoding="utf-8"), filename=str(WRITER_PATH))
    failures: list[str] = []
    for name, case in CASES:
        try:
            case()
        except Exception as error:
            failures.append(f"{name}: {type(error).__name__}: {error}")
            print(f"{name}=FAIL:{type(error).__name__}:{error}", file=sys.stderr)
        else:
            print(f"{name}=PASS")
    if failures:
        print("TARGETED_DEFECT_FAMILY_GATE=FAIL")
        return 1
    print("TARGETED_DEFECT_FAMILY_GATE=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
