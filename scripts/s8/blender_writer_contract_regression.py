#!/usr/bin/env python3
"""Offline F/C/H/S regression gate for the amended S8 Blender writer contract.

The gate uses a deliberately small Blender-shaped test double so the defect
families can run on a clean Python installation. The production writer still
performs the same proofs against the pinned Blender runtime and private
exporter; this harness does not replace that runtime qualification.
"""

from __future__ import annotations

from dataclasses import dataclass

import ast
import hashlib
import importlib.util
import inspect
import pathlib
import sys
import tempfile
import types
from typing import Any, Callable, Iterable
from unittest.mock import patch


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
        self.instance_collection_set_attempts = 0
        self._instance_collection = None
        self.library = None
        self.override_library = None
        self.modifiers: list[Any] = []
        self.constraints: list[Any] = []
        self.particle_systems: list[Any] = []
        self.original = self
        self.custom: dict[str, Any] = {}
        self.selected = False

    @property
    def instance_collection(self) -> Any:
        return self._instance_collection

    @instance_collection.setter
    def instance_collection(self, value: Any) -> None:
        if self.type == "MESH":
            self.instance_collection_set_attempts += 1
            raise AssertionError("instance_collection cannot be assigned on a MESH object")
        self._instance_collection = value

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


class FakeViewLayer:
    def __init__(self, scene_objects: FakeObjectCollection, events: list[str]):
        self.objects = FakeObjectCollection()
        self.scene_objects = scene_objects
        self.events = events
        self.active = None

    def update(self) -> None:
        self.objects[:] = list(self.scene_objects)
        self.events.append("VIEWLAYER_UPDATE")


@dataclass(frozen=True)
class FakeDepsgraphInstanceRecord:
    """Durable fixture data from which a fresh depsgraph wrapper is created."""

    object: Any
    is_instance: bool


class FakeDepsgraphObjectInstance:
    _INVALID_ACCESS = "DepsgraphObjectInstance wrapper is no longer valid"

    def __init__(self, record: FakeDepsgraphInstanceRecord):
        self._record = record
        self._valid = True

    def _require_valid(self) -> None:
        if not self._valid:
            raise ReferenceError(self._INVALID_ACCESS)

    def invalidate(self) -> None:
        self._valid = False

    @property
    def object(self) -> Any:
        self._require_valid()
        return self._record.object

    @property
    def is_instance(self) -> bool:
        self._require_valid()
        return self._record.is_instance


class FakeDepsgraphInstanceCollection:
    """Re-iterable durable records with traversal-scoped wrapper lifetimes."""

    def __init__(self, records: Iterable[FakeDepsgraphInstanceRecord] = ()):
        self._fixture_records = list(records)

    @property
    def fixture_records(self) -> tuple[FakeDepsgraphInstanceRecord, ...]:
        return tuple(self._fixture_records)

    @staticmethod
    def _require_record(record: FakeDepsgraphInstanceRecord) -> None:
        if type(record) is not FakeDepsgraphInstanceRecord:
            raise TypeError("depsgraph fixture collections accept durable instance records only")

    def append(self, record: FakeDepsgraphInstanceRecord) -> None:
        self._require_record(record)
        self._fixture_records.append(record)

    def pop(self, index: int = -1) -> FakeDepsgraphInstanceRecord:
        return self._fixture_records.pop(index)

    def replace(self, index: int, record: FakeDepsgraphInstanceRecord) -> None:
        self._require_record(record)
        self._fixture_records[index] = record

    def __iter__(self):
        previous: FakeDepsgraphObjectInstance | None = None
        try:
            for record in self._fixture_records:
                if previous is not None:
                    previous.invalidate()
                previous = FakeDepsgraphObjectInstance(record)
                yield previous
        finally:
            if previous is not None:
                previous.invalidate()


class FakeWorld:
    def __init__(self, events: list[str] | None = None) -> None:
        self.events = events if events is not None else []
        self.data = types.SimpleNamespace()
        self.data.objects = FakeObjectCollection()
        self.data.filepath = ""
        self.data.meshes = FakeCollection(lambda name: FakeMesh(name))
        self.data.materials = FakeCollection(lambda name: FakeMaterial(name))
        self.data.curves = FakeCollection()
        self.data.cameras = FakeCollection()
        self.data.lights = FakeCollection()
        self.scene = types.SimpleNamespace()
        self.scene.collection = types.SimpleNamespace(objects=FakeLinkCollection(self.data.objects))
        self.scene.objects = self.data.objects
        self.scene.unit_settings = types.SimpleNamespace()
        self.view_layer = FakeViewLayer(self.scene.objects, self.events)
        self.graph = None
        self.context = types.SimpleNamespace(
            scene=self.scene,
            view_layer=self.view_layer,
            evaluated_depsgraph_get=self.evaluated_depsgraph_get,
        )
        self.bpy = types.SimpleNamespace(data=self.data, context=self.context)

    def evaluated_depsgraph_get(self) -> Any:
        self.events.append("evaluated_depsgraph_get")
        if self.graph is None:
            self.graph = FakeDepsgraph(self.view_layer.objects)
        return self.graph

    def new_graph(self) -> Any:
        self.graph = FakeDepsgraph(self.view_layer.objects)
        return self.graph


class FakeDepsgraph:
    def __init__(self, objects: FakeObjectCollection):
        self.view_layer = types.SimpleNamespace(objects=objects)
        self.objects = objects
        self.object_instances = FakeDepsgraphInstanceCollection(
            FakeDepsgraphInstanceRecord(object=obj, is_instance=False) for obj in objects
        )


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
    world.view_layer.update()
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


def expect_reference_error(action: Callable[[], Any]) -> None:
    try:
        action()
    except ReferenceError as error:
        if type(error) is not ReferenceError or str(error) != FakeDepsgraphObjectInstance._INVALID_ACCESS:
            raise AssertionError(f"expected deterministic ReferenceError, received {type(error).__name__}: {error}") from error
        return
    except Exception as error:
        raise AssertionError(f"expected ReferenceError, received {type(error).__name__}: {error}") from error
    raise AssertionError("expected ReferenceError, action succeeded")


def test_viewlayer_deferred_membership() -> None:
    world = FakeWorld()
    install_world(world)
    admission = writer.admit_payload(make_payload(["obj-a", "obj-b"]))
    state = writer.construct_scene(admission)
    expected = state["objects"]

    if world.view_layer.objects is world.data.objects:
        raise AssertionError("fake ViewLayer aliases bpy.data.objects")
    writer._assert_surface_identity(world.scene.objects, expected)
    writer._assert_surface_identity(world.data.objects, expected)
    if list(world.view_layer.objects):
        raise AssertionError("fake ViewLayer synchronized during construction or read")
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.audit_original_scene(admission, state))

    world.view_layer.update()
    writer.audit_original_scene(admission, state)
    graph = world.evaluated_depsgraph_get()
    writer.audit_evaluated_membership(admission, state, graph)
    print("ORIGINAL_SCENE_MEMBERSHIP=PASS")
    print("EVALUATED_MEMBERSHIP=PASS")
    print("VIEWLAYER_SYNC_BEFORE_AUDIT=PASS")
    print("VIEWLAYER_DEFERRED_MEMBERSHIP_REGRESSION=PASS")

    world, _payload, admission, state, _graph = make_state()
    extra = FakeObject("SWZ_EXTRA", FakeMesh("SWZ_EXTRA_MESH"))
    world.scene.collection.objects.link(extra)
    world.view_layer.update()
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.audit_original_scene(admission, state))
    print("EXTRA_OBJECT_REJECTION=PASS")

    world, _payload, admission, state, _graph = make_state()
    world.data.objects.remove(state["objects"]["SWZ_ROOT"])
    world.view_layer.update()
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.audit_original_scene(admission, state))
    print("MISSING_OBJECT_REJECTION=PASS")

    world, _payload, admission, state, _graph = make_state()
    world.data.objects.append(state["objects"]["SWZ_ROOT"])
    world.view_layer.update()
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.audit_original_scene(admission, state))
    print("DUPLICATE_OBJECT_REJECTION=PASS")

    world, _payload, admission, state, _graph = make_state()
    expected_object = state["objects"]["SWZ_ROOT"]
    world.view_layer.objects[0] = FakeObject(expected_object.name, expected_object.data)
    expect_error("S8_EXPORT_OBJECT_SET_INVALID", lambda: writer.audit_original_scene(admission, state))
    print("WRONG_OBJECT_IDENTITY_REJECTION=PASS")


def test_production_main_viewlayer_order() -> None:
    events: list[str] = []
    world = FakeWorld(events)
    install_world(world)
    payload = make_payload(["obj-a"])
    original_construct_scene = writer.construct_scene
    original_audit_original_scene = writer.audit_original_scene

    def observed_construct_scene(admission: dict[str, Any]) -> dict[str, Any]:
        events.append("construct_scene")
        return original_construct_scene(admission)

    def observed_audit_original_scene(admission: dict[str, Any], state: dict[str, Any]) -> None:
        events.append("audit_original_scene")
        original_audit_original_scene(admission, state)

    def fake_export(artifact_path: pathlib.Path, *_args: Any, **_kwargs: Any) -> None:
        header = b"Kaydara FBX Binary  \x00\x1a\x00" + (7400).to_bytes(4, "little")
        artifact_path.write_bytes(header + b"x")

    with tempfile.TemporaryDirectory(prefix="s8-writer-main-order-") as directory:
        output_root = pathlib.Path(directory)
        (output_root / "input.json").write_bytes(b"{}")
        exporter = FakeExporter()
        with (
            patch.object(writer, "fixed_path", side_effect=lambda name: output_root / name),
            patch.object(writer, "load_payload", return_value=payload),
            patch.object(writer, "assert_runtime", return_value={"version": "fake"}),
            patch.object(writer, "load_private_exporter", return_value=exporter),
            patch.object(writer, "require_factory_filepath", return_value=None),
            patch.object(writer, "construct_scene", side_effect=observed_construct_scene),
            patch.object(writer, "audit_original_scene", side_effect=observed_audit_original_scene),
            patch.object(writer, "export_fbx", side_effect=fake_export),
        ):
            writer.main()

    expected_events = [
        "construct_scene",
        "VIEWLAYER_UPDATE",
        "audit_original_scene",
        "evaluated_depsgraph_get",
    ]
    if events != expected_events:
        raise AssertionError(f"production main synchronization order mismatch: {events}")

    tree = ast.parse(WRITER_PATH.read_text(encoding="utf-8"), filename=str(WRITER_PATH))
    main_node = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "main"
    )
    ordered_calls: list[str] = []
    for node in sorted(ast.walk(main_node), key=lambda item: getattr(item, "lineno", 0)):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id in {"construct_scene", "audit_original_scene"}:
            ordered_calls.append(node.func.id)
        elif isinstance(node.func, ast.Attribute) and node.func.attr in {"update", "evaluated_depsgraph_get"}:
            ordered_calls.append("VIEWLAYER_UPDATE" if node.func.attr == "update" else "evaluated_depsgraph_get")
    if ordered_calls != expected_events:
        raise AssertionError(f"supplementary production source order mismatch: {ordered_calls}")
    print("VIEWLAYER_SYNC_BEFORE_AUDIT=PASS")


def test_instance_collection_contract() -> None:
    _world, _payload, admission, state, graph = make_state()
    root = state["objects"]["SWZ_ROOT"]
    mesh = next(obj for name, obj in state["objects"].items() if name != "SWZ_ROOT")
    writer._assert_neutral_object(root, True)
    writer._assert_neutral_object(mesh, False)
    if root.instance_collection is not None or mesh.instance_collection is not None:
        raise AssertionError("ordinary objects retained collection instancing state")
    if mesh.instance_collection_set_attempts != 0:
        raise AssertionError("production writer assigned instance_collection on a MESH object")

    setter_probe = FakeObject("SWZ_PROBE", FakeMesh("SWZ_PROBE_MESH"))
    try:
        setter_probe.instance_collection = None
    except AssertionError:
        pass
    else:
        raise AssertionError("fake MESH instance_collection setter did not reject a write")
    if setter_probe.instance_collection_set_attempts != 1:
        raise AssertionError("fake MESH setter did not count its rejected write")

    print("EMPTY_INSTANCE_COLLECTION_NEUTRAL=PASS")
    print("MESH_UNSUPPORTED_INSTANCE_COLLECTION_MUTATION=ABSENT")

    root.instance_collection = object()
    expect_error("S8_EXPORT_INSTANCE_FORBIDDEN", lambda: writer._assert_neutral_object(root, True))
    mesh._instance_collection = object()
    expect_error("S8_EXPORT_INSTANCE_FORBIDDEN", lambda: writer._assert_neutral_object(mesh, False))
    mesh._instance_collection = None
    mesh.instance_type = "COLLECTION"
    expect_error("S8_EXPORT_INSTANCE_FORBIDDEN", lambda: writer._assert_neutral_object(mesh, False))
    mesh.instance_type = "NONE"
    print("COLLECTION_INSTANCE_REJECTION=PASS")

    graph.object_instances.append(FakeDepsgraphInstanceRecord(object=mesh, is_instance=True))
    expect_error(
        "S8_EXPORT_INSTANCE_FORBIDDEN",
        lambda: writer.audit_evaluated_membership(admission, state, graph),
    )
    print("INSTANCE_TRUE=S8_EXPORT_INSTANCE_FORBIDDEN")
    print("DEPSGRAPH_INSTANCE_REJECTION=PASS")


def reproduce_sequence_materialization(instances: FakeDepsgraphInstanceCollection, materializer: Callable[..., Any]) -> None:
    wrappers = materializer(instances)
    for wrapper in wrappers:
        _ = wrapper.is_instance
        _ = wrapper.object


def test_depsgraph_instance_lifetime_contract() -> None:
    _world, _payload, admission, state, graph = make_state()
    if any(type(record) is not FakeDepsgraphInstanceRecord for record in graph.object_instances.fixture_records):
        raise AssertionError("depsgraph fixture collection retained non-record data")

    captured_originals: list[Any] = []
    original_object = writer._original_object

    def capture_original(value: Any) -> Any:
        result = original_object(value)
        captured_originals.append(result)
        return result

    with patch.object(writer, "_original_object", side_effect=capture_original):
        writer.audit_evaluated_membership(admission, state, graph)

    expected_count = len(state["objects"])
    traversed_originals = captured_originals[-expected_count:]
    if len(traversed_originals) != expected_count or any(
        state["objects"].get(getattr(value, "name", None)) is not value
        for value in traversed_originals
    ):
        raise AssertionError("production audit did not retain stable original object identities")
    print("NORMAL_NON_INSTANCED_OBJECT_SET=PASS")
    print("GREEN_ACTUAL_PRODUCTION_DIRECT_ITERATION=PASS")
    print("RETAINED_STABLE_ORIGINAL_IDENTITY=PASS")

    scalar_snapshots: list[tuple[bool, str, int]] = []
    for wrapper in graph.object_instances:
        original = wrapper.object
        is_instance = wrapper.is_instance
        scalar_snapshots.append((is_instance, original.name, id(original)))
    expected_names = {obj.name for obj in state["objects"].values()}
    if {name for _is_instance, name, _identity in scalar_snapshots} != expected_names:
        raise AssertionError("immutable scalar snapshots did not cover the expected object set")
    if any(is_instance for is_instance, _name, _identity in scalar_snapshots):
        raise AssertionError("normal fixture unexpectedly marked an instance")
    print("RETAINED_IMMUTABLE_VALUES=PASS")

    first_traversal = list(iter(graph.object_instances))
    second_traversal = list(iter(graph.object_instances))
    if len(first_traversal) != len(second_traversal) or any(
        first is second for first, second in zip(first_traversal, second_traversal)
    ):
        raise AssertionError("depsgraph traversals did not create fresh wrappers")
    if not all(not wrapper._valid for wrapper in (*first_traversal, *second_traversal)):
        raise AssertionError("wrapper remained valid after traversal exhaustion")
    try:
        graph.object_instances.append(first_traversal[0])
    except TypeError:
        pass
    else:
        raise AssertionError("depsgraph fixture accepted a wrapper as durable record data")
    print("FRESH_WRAPPER_PER_TRAVERSAL=PASS")
    print("DURABLE_FIXTURE_RECORDS_ONLY=PASS")

    for label, materializer in (("LIST", list), ("TUPLE", tuple)):
        _world, _payload, _red_admission, _red_state, red_graph = make_state()
        expect_reference_error(
            lambda: reproduce_sequence_materialization(red_graph.object_instances, materializer)
        )
        print(f"RED_SEQUENCE_MATERIALISATION_{label}=ReferenceError")

    iterator = iter(graph.object_instances)
    first = next(iterator)
    second = next(iterator)
    expect_reference_error(lambda: first.object)
    expect_reference_error(lambda: first.is_instance)
    print("WRAPPER_PROPERTY_AFTER_ADVANCEMENT=ReferenceError")
    iterator.close()
    expect_reference_error(lambda: second.object)
    expect_reference_error(lambda: second.is_instance)
    print("FINAL_WRAPPER_AFTER_CLOSE=ReferenceError")

    exhausted_iterator = iter(graph.object_instances)
    last: FakeDepsgraphObjectInstance | None = None
    for last in exhausted_iterator:
        pass
    if last is None:
        raise AssertionError("normal graph unexpectedly had no instance records")
    expect_reference_error(lambda: last.object)
    expect_reference_error(lambda: last.is_instance)
    print("FINAL_WRAPPER_AFTER_EXHAUSTION=ReferenceError")


def test_depsgraph_instance_membership_failures() -> None:
    _world, _payload, admission, state, graph = make_state()
    mesh = next(obj for name, obj in state["objects"].items() if name != "SWZ_ROOT")
    graph.object_instances.append(FakeDepsgraphInstanceRecord(object=mesh, is_instance=False))
    expect_error(
        "S8_EXPORT_INSTANCE_FORBIDDEN",
        lambda: writer.audit_evaluated_membership(admission, state, graph),
    )
    print("DUPLICATE_ORIGINAL=S8_EXPORT_INSTANCE_FORBIDDEN")

    _world, _payload, admission, state, graph = make_state()
    unexpected = FakeObject("SWZ_UNEXPECTED", FakeMesh("SWZ_UNEXPECTED_MESH"))
    graph.object_instances.append(FakeDepsgraphInstanceRecord(object=unexpected, is_instance=False))
    expect_error(
        "S8_EXPORT_INSTANCE_FORBIDDEN",
        lambda: writer.audit_evaluated_membership(admission, state, graph),
    )
    print("UNEXPECTED_OBJECT=S8_EXPORT_INSTANCE_FORBIDDEN")

    _world, _payload, admission, state, graph = make_state()
    graph.object_instances.pop()
    expect_error(
        "S8_EXPORT_OBJECT_SET_INVALID",
        lambda: writer.audit_evaluated_membership(admission, state, graph),
    )
    print("MISSING_EXPECTED_OBJECT=S8_EXPORT_OBJECT_SET_INVALID")

    _world, _payload, admission, state, graph = make_state()
    mesh_name, mesh = next((name, obj) for name, obj in state["objects"].items() if name != "SWZ_ROOT")
    wrong_original = FakeObject(mesh_name, mesh.data)
    evaluated = FakeObject(mesh_name, mesh.data)
    evaluated.original = wrong_original
    index = next(
        index for index, record in enumerate(graph.object_instances.fixture_records)
        if record.object is mesh
    )
    graph.object_instances.replace(
        index,
        FakeDepsgraphInstanceRecord(object=evaluated, is_instance=False),
    )
    expect_error(
        "S8_EXPORT_INSTANCE_FORBIDDEN",
        lambda: writer.audit_evaluated_membership(admission, state, graph),
    )
    print("WRONG_ORIGINAL_IDENTITY=S8_EXPORT_INSTANCE_FORBIDDEN")


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
    ("VIEWLAYER", test_viewlayer_deferred_membership),
    ("MAIN_ORDER", test_production_main_viewlayer_order),
    ("INSTANCE", test_instance_collection_contract),
    ("INSTANCE_LIFETIME", test_depsgraph_instance_lifetime_contract),
    ("INSTANCE_MEMBERSHIP_FAILURES", test_depsgraph_instance_membership_failures),
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
    print("WRITER_CONTRACT_REGRESSION=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
