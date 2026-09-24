#!/usr/bin/env python3
"""Executable provenance contract for the pinned native FBX validator.

Fixtures are bounded deterministic binary FBX 7400 files written into a
temporary directory. Every case invokes the compiled validator process.
"""
from __future__ import annotations

import json
import pathlib
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Iterable

MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
NULL_RECORD = bytes(13)
MAX_FIXTURE_BYTES = 128 * 1024
MAX_FIXTURE_COUNT = 64
IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
ROOT_KEYS = {"name", "parent", "effectiveScale", "nodeToParent", "nodeToWorld", "mesh"}
SOURCE_METADATA = {
    "revisionId": "run-074-fixture",
    "revisionHash": "a" * 64,
    "s6ValidationHash": "b" * 64,
    "s6HandoffDigest": "c" * 64,
}
MISSING = object()


@dataclass(frozen=True)
class Field:
    kind: str
    value: object


@dataclass(frozen=True)
class ModelSpec:
    name: str
    parent_index: int | None
    has_mesh: bool = True
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    source_object_id: Field | None = None
    identity_key: Field | None = None
    extra_properties: tuple[tuple[str, Field], ...] = ()


@dataclass(frozen=True)
class FbxNode:
    name: bytes
    properties: tuple[bytes, ...] = ()
    children: tuple["FbxNode", ...] = ()


def prop_string(value: str | bytes) -> bytes:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    if len(raw) > 8192:
        raise ValueError("fixture string exceeds deterministic bound")
    return b"S" + struct.pack("<I", len(raw)) + raw


def binary_object_name(name: str, object_type: str) -> bytes:
    return name.encode("ascii") + b"\x00\x01" + object_type.encode("ascii")


def prop_int32(value: int) -> bytes:
    return b"I" + struct.pack("<i", value)


def prop_int64(value: int) -> bytes:
    return b"L" + struct.pack("<q", value)


def prop_double(value: float) -> bytes:
    return b"D" + struct.pack("<d", value)


def prop_array(kind: str, values: Iterable[float | int]) -> bytes:
    materialized = tuple(values)
    if kind == "d":
        raw = struct.pack("<" + "d" * len(materialized), *materialized)
    elif kind == "i":
        raw = struct.pack("<" + "i" * len(materialized), *materialized)
    else:
        raise ValueError(f"unsupported fixture array kind: {kind}")
    return kind.encode("ascii") + struct.pack("<III", len(materialized), 0, len(raw)) + raw


def node(name: str, properties: Iterable[bytes] = (), children: Iterable[FbxNode] = ()) -> FbxNode:
    encoded_name = name.encode("ascii")
    if not encoded_name or len(encoded_name) > 255:
        raise ValueError("invalid fixture node name")
    return FbxNode(encoded_name, tuple(properties), tuple(children))


def encode_node(item: FbxNode, offset: int) -> bytes:
    property_data = b"".join(item.properties)
    child_data = bytearray()
    child_offset = offset + 13 + len(item.name) + len(property_data)
    for child in item.children:
        child_data.extend(encode_node(child, child_offset + len(child_data)))
    if item.children:
        child_data.extend(NULL_RECORD)
    end_offset = offset + 13 + len(item.name) + len(property_data) + len(child_data)
    header = struct.pack("<IIIB", end_offset, len(item.properties), len(property_data), len(item.name))
    return header + item.name + property_data + bytes(child_data)


def field_property(name: str, field: Field) -> FbxNode:
    if field.kind == "string":
        value = field.value
        if not isinstance(value, (str, bytes)):
            raise TypeError("string fixture property must contain text")
        values = (
            prop_string(name), prop_string("KString"), prop_string(""), prop_string("U"), prop_string(value),
        )
    elif field.kind == "int":
        values = (
            prop_string(name), prop_string("int"), prop_string("Integer"), prop_string("U"),
            prop_int32(int(field.value)),
        )
    elif field.kind == "vector3":
        vector = tuple(float(value) for value in field.value)  # type: ignore[arg-type]
        if len(vector) != 3:
            raise ValueError("vector fixture property must have three values")
        values = (
            prop_string(name), prop_string(name), prop_string("Vector3D"), prop_string("A"),
            *(prop_double(value) for value in vector),
        )
    elif field.kind == "double":
        values = (
            prop_string(name), prop_string("double"), prop_string("Number"), prop_string(""),
            prop_double(float(field.value)),
        )
    else:
        raise ValueError(f"unsupported fixture property kind: {field.kind}")
    return node("P", values)


def global_property(name: str, kind: str, value: int | float) -> FbxNode:
    if kind == "int":
        field = Field("int", int(value))
    elif kind == "double":
        field = Field("double", float(value))
    else:
        raise ValueError("unsupported global setting property")
    return field_property(name, field)


def geometry_node(geometry_id: int, name: str) -> FbxNode:
    normal = node(
        "LayerElementNormal",
        (prop_int32(0),),
        (
            node("Version", (prop_int32(101),)),
            node("Name", (prop_string(""),)),
            node("MappingInformationType", (prop_string("ByPolygonVertex"),)),
            node("ReferenceInformationType", (prop_string("Direct"),)),
            node("Normals", (prop_array("d", (0.0, 0.0, 1.0) * 3),)),
        ),
    )
    layer = node(
        "Layer",
        (prop_int32(0),),
        (
            node(
                "LayerElement",
                (),
                (
                    node("Type", (prop_string("LayerElementNormal"),)),
                    node("TypedIndex", (prop_int32(0),)),
                ),
            ),
        ),
    )
    return node(
        "Geometry",
        (
            prop_int64(geometry_id),
            prop_string(binary_object_name(name, "Geometry")),
            prop_string("Mesh"),
        ),
        (
            node("GeometryVersion", (prop_int32(124),)),
            node("Vertices", (prop_array("d", (0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0)),)),
            node("PolygonVertexIndex", (prop_array("i", (0, 1, -3)),)),
            normal,
            layer,
        ),
    )


def build_fbx(models: tuple[ModelSpec, ...]) -> bytes:
    if not models or len(models) > 8:
        raise ValueError("fixture model count outside deterministic bound")
    model_ids = tuple(1001 + index for index in range(len(models)))
    geometry_ids = tuple(5001 + index for index in range(len(models)))
    object_nodes: list[FbxNode] = []
    connection_nodes: list[FbxNode] = []

    for index, spec in enumerate(models):
        if spec.parent_index is not None and not (0 <= spec.parent_index < len(models)):
            raise ValueError("fixture parent index out of bounds")
        model_properties = [
            field_property("RotationActive", Field("int", 0)),
            field_property("Lcl Translation", Field("vector3", spec.translation)),
            field_property("Lcl Rotation", Field("vector3", (0.0, 0.0, 0.0))),
            field_property("Lcl Scaling", Field("vector3", spec.scale)),
        ]
        if spec.name == "SWZ_ROOT":
            model_properties.extend(
                field_property(f"swz_{key}", Field("string", value))
                for key, value in SOURCE_METADATA.items()
            )
        for key, value in (
            ("swz_object_id", spec.source_object_id),
            ("swz_identity_key", spec.identity_key),
        ):
            if value is not None:
                model_properties.append(field_property(key, value))
        model_properties.extend(field_property(key, value) for key, value in spec.extra_properties)

        subtype = "Mesh" if spec.has_mesh else "Null"
        object_nodes.append(
            node(
                "Model",
                (
                    prop_int64(model_ids[index]),
                    prop_string(binary_object_name(spec.name, "Model")),
                    prop_string(subtype),
                ),
                (
                    node("Version", (prop_int32(232),)),
                    node("Properties70", (), tuple(model_properties)),
                ),
            )
        )
        parent_id = 0 if spec.parent_index is None else model_ids[spec.parent_index]
        connection_nodes.append(node("C", (prop_string("OO"), prop_int64(model_ids[index]), prop_int64(parent_id))))
        if spec.has_mesh:
            object_nodes.append(geometry_node(geometry_ids[index], spec.name))
            connection_nodes.append(
                node("C", (prop_string("OO"), prop_int64(geometry_ids[index]), prop_int64(model_ids[index])))
            )

    document = node(
        "Document",
        (prop_int64(0), prop_string("Scene"), prop_string("")),
        (node("RootNode", (prop_int64(0),)),),
    )
    header_extension = node(
        "FBXHeaderExtension",
        (),
        (
            node("FBXHeaderVersion", (prop_int32(1003),)),
            node("FBXVersion", (prop_int32(7400),)),
            node("EncryptionType", (prop_int32(0),)),
        ),
    )
    documents = node("Documents", (), (node("Count", (prop_int32(1),)), document))
    definitions = node(
        "Definitions", (), (node("Version", (prop_int32(100),)), node("Count", (prop_int32(0),)))
    )
    connections = node("Connections", (), tuple(connection_nodes))
    takes = node("Takes", (), (node("Current", (prop_string(""),)),))
    settings = node(
        "GlobalSettings",
        (),
        (
            node("Version", (prop_int32(1000),)),
            node(
                "Properties70",
                (),
                (
                    global_property("UpAxis", "int", 2),
                    global_property("UpAxisSign", "int", 1),
                    global_property("FrontAxis", "int", 1),
                    global_property("FrontAxisSign", "int", -1),
                    global_property("CoordAxis", "int", 0),
                    global_property("CoordAxisSign", "int", 1),
                    global_property("UnitScaleFactor", "double", 0.1),
                    global_property("OriginalUnitScaleFactor", "double", 0.1),
                ),
            ),
        ),
    )
    top_level = (
        header_extension,
        settings,
        documents,
        definitions,
        node("Objects", (), tuple(object_nodes)),
        connections,
        takes,
    )
    data = bytearray(MAGIC + struct.pack("<I", 7400))
    for item in top_level:
        data.extend(encode_node(item, len(data)))
    data.extend(NULL_RECORD)
    if len(data) > MAX_FIXTURE_BYTES:
        raise ValueError(f"fixture exceeded {MAX_FIXTURE_BYTES} bytes")
    return bytes(data)


def root_model(
    *,
    parent_index: int | None = None,
    has_mesh: bool = False,
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    extra_properties: tuple[tuple[str, Field], ...] = (),
) -> ModelSpec:
    return ModelSpec(
        "SWZ_ROOT",
        parent_index,
        has_mesh,
        translation,
        scale,
        extra_properties=extra_properties,
    )


def physical_model(
    index: int,
    *,
    parent_index: int | None = 0,
    has_mesh: bool = True,
    source_object_id: Field | None | object = MISSING,
    identity_key: Field | None | object = MISSING,
    name: str | None = None,
) -> ModelSpec:
    source_field = Field("string", f"source-object-{index}") if source_object_id is MISSING else source_object_id
    identity_field = Field("string", f"identity-key-{index}") if identity_key is MISSING else identity_key
    if source_field is not None and not isinstance(source_field, Field):
        raise TypeError("invalid source object ID fixture field")
    if identity_field is not None and not isinstance(identity_field, Field):
        raise TypeError("invalid identity key fixture field")
    return ModelSpec(
        name or f"PHYSICAL_{index}",
        parent_index,
        has_mesh,
        source_object_id=source_field,
        identity_key=identity_field,
    )


def run_validator(
    executable: pathlib.Path,
    directory: pathlib.Path,
    case: str,
    models: tuple[ModelSpec, ...],
    expected_failure: str | None = None,
) -> dict[str, object] | None:
    fixture = build_fbx(models)
    if len(list(directory.glob("*.fbx"))) >= MAX_FIXTURE_COUNT:
        raise AssertionError("fixture count exceeded deterministic bound")
    path = directory / f"{case}.fbx"
    path.write_bytes(fixture)
    result = subprocess.run(
        [str(executable), str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if expected_failure is not None:
        expected_stderr = f"S8_VALIDATOR_FAIL:{expected_failure}"
        if result.returncode != 1 or result.stderr.strip() != expected_stderr or result.stdout:
            raise AssertionError(
                f"{case}: expected exit=1 stderr={expected_stderr!r} stdout empty; "
                f"got exit={result.returncode} stderr={result.stderr.strip()!r} "
                f"stdout_prefix={result.stdout[:160]!r}"
            )
        print(f"{case}=PASS;DIAGNOSTIC={expected_failure}")
        return None
    if result.returncode != 0 or result.stderr:
        raise AssertionError(
            f"{case}: expected process success; exit={result.returncode} "
            f"stderr={result.stderr.strip()!r} stdout_prefix={result.stdout[:160]!r}"
        )
    try:
        readback = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{case}: validator stdout was not parseable JSON: {error}") from error
    if not isinstance(readback, dict):
        raise AssertionError(f"{case}: validator JSON root was not an object")
    return readback


def assert_success_shape(
    readback: dict[str, object],
    models: tuple[ModelSpec, ...],
    expected_ids: dict[str, tuple[str, str]],
) -> None:
    if readback.get("schemaVersion") != "s8-ufbx-readback-v1":
        raise AssertionError("success schema mismatch")
    if readback.get("fbxVersion") != 7400 or readback.get("unitMeters") != 0.001:
        raise AssertionError("success FBX profile mismatch")
    if readback.get("warningCount") != 0 or readback.get("source") != SOURCE_METADATA:
        raise AssertionError("success top-level source metadata mismatch")
    nodes = readback.get("nodes")
    if not isinstance(nodes, list):
        raise AssertionError("success nodes were not an array")
    expected_physical = [model for model in models if model.name != "SWZ_ROOT"]
    if len(nodes) != len(expected_physical) + 1:
        raise AssertionError("success node count mismatch")
    named = [item for item in nodes if isinstance(item, dict) and item.get("name") == "SWZ_ROOT"]
    if len(named) != 1:
        raise AssertionError("success did not contain exactly one named root")
    root = named[0]
    expected_root = {
        "name": "SWZ_ROOT",
        "parent": None,
        "effectiveScale": [1, 1, 1],
        "nodeToParent": IDENTITY,
        "nodeToWorld": IDENTITY,
        "mesh": None,
    }
    if root != expected_root or set(root) != ROOT_KEYS:
        raise AssertionError(f"synthetic root shape mismatch: {root!r}")
    if "sourceObjectId" in root or "identityKey" in root:
        raise AssertionError("synthetic root emitted physical provenance")

    for spec in models:
        if spec.name == "SWZ_ROOT":
            continue
        matches = [item for item in nodes if isinstance(item, dict) and item.get("name") == spec.name]
        if len(matches) != 1:
            raise AssertionError(f"physical node {spec.name!r} was absent or duplicated")
        physical = matches[0]
        source_id, identity_key = expected_ids[spec.name]
        if physical.get("sourceObjectId") != source_id or physical.get("identityKey") != identity_key:
            raise AssertionError(f"physical provenance changed for {spec.name!r}")
        expected_parent = None if spec.parent_index is None else models[spec.parent_index].name
        if physical.get("parent") != expected_parent:
            raise AssertionError(f"physical parent mismatch for {spec.name!r}")
        mesh = physical.get("mesh")
        if not isinstance(mesh, dict):
            raise AssertionError(f"physical mesh missing for {spec.name!r}")
        if len(mesh.get("vertices", [])) != 3 or mesh.get("triangles") != [[0, 1, 2]]:
            raise AssertionError(f"physical triangle geometry mismatch for {spec.name!r}")
        if len(mesh.get("cornerNormals", [])) != 3:
            raise AssertionError(f"physical corner normals mismatch for {spec.name!r}")


def good_models(*, long_values: bool = False) -> tuple[ModelSpec, ...]:
    source_id = "i" * 4096 if long_values else "source-object-0"
    identity_key = "k" * 4096 if long_values else "identity-key-0"
    return (
        root_model(),
        physical_model(
            0,
            source_object_id=Field("string", source_id),
            identity_key=Field("string", identity_key),
        ),
    )


def expect_failure(
    executable: pathlib.Path,
    directory: pathlib.Path,
    case: str,
    models: tuple[ModelSpec, ...],
    diagnostic: str,
) -> None:
    run_validator(executable, directory, case, models, diagnostic)


def run_matrix(executable: pathlib.Path) -> None:
    with tempfile.TemporaryDirectory(prefix="s8-native-provenance-") as temporary:
        directory = pathlib.Path(temporary)
        top_level = good_models()
        top_readback = run_validator(executable, directory, "valid-top-level", top_level)
        assert top_readback is not None
        assert_success_shape(top_readback, top_level, {"PHYSICAL_0": ("source-object-0", "identity-key-0")})
        print("VALID_SYNTHETIC_ROOT_AND_PHYSICAL_NODES=PASS")
        print("VALID_ROOT_PROVENANCE_SHAPE=PASS")
        print("ROOT_READBACK_PROVENANCE_KEYS_ABSENT=PASS")
        print("VALID_PHYSICAL_SOURCE_OBJECT_ID_AND_IDENTITY_KEY=PASS")
        print("VALID_TOP_LEVEL_HIERARCHY=PASS")

        nested = (root_model(), physical_model(0), physical_model(1, parent_index=1))
        nested_readback = run_validator(executable, directory, "valid-nested", nested)
        assert nested_readback is not None
        assert_success_shape(
            nested_readback,
            nested,
            {
                "PHYSICAL_0": ("source-object-0", "identity-key-0"),
                "PHYSICAL_1": ("source-object-1", "identity-key-1"),
            },
        )
        print("VALID_NESTED_HIERARCHY=PASS")

        long_models = good_models(long_values=True)
        long_readback = run_validator(executable, directory, "valid-4096-byte-values", long_models)
        assert long_readback is not None
        assert_success_shape(long_readback, long_models, {"PHYSICAL_0": ("i" * 4096, "k" * 4096)})
        print("VALID_4096_BYTE_PHYSICAL_VALUES=PASS")

        expect_failure(executable, directory, "physical-missing-source-id",
            (root_model(), physical_model(0, source_object_id=None)), "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-missing-identity-key",
            (root_model(), physical_model(0, identity_key=None)), "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-empty-source-id",
            (root_model(), physical_model(0, source_object_id=Field("string", ""))),
            "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-empty-identity-key",
            (root_model(), physical_model(0, identity_key=Field("string", ""))),
            "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-oversized-source-id",
            (root_model(), physical_model(0, source_object_id=Field("string", "x" * 4097))),
            "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-oversized-identity-key",
            (root_model(), physical_model(0, identity_key=Field("string", "x" * 4097))),
            "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-nonstring-source-id",
            (root_model(), physical_model(0, source_object_id=Field("int", 7))),
            "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-nonstring-identity-key",
            (root_model(), physical_model(0, identity_key=Field("int", 7))),
            "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(executable, directory, "physical-reserved-source-id",
            (root_model(), physical_model(0, source_object_id=Field("string", "SWZ_ROOT"))),
            "SOURCE_OBJECT_ID_RESERVED")
        expect_failure(
            executable, directory, "duplicate-physical-source-id",
            (
                root_model(),
                physical_model(0, source_object_id=Field("string", "duplicate-source")),
                physical_model(1, source_object_id=Field("string", "duplicate-source")),
            ),
            "SOURCE_OBJECT_ID_DUPLICATE",
        )
        expect_failure(
            executable, directory, "root-with-source-object-id",
            (
                root_model(extra_properties=(("swz_object_id", Field("int", 7)),)),
                physical_model(0),
            ),
            "ROOT_SOURCE_PROVENANCE_FORBIDDEN",
        )
        expect_failure(
            executable, directory, "root-with-identity-key",
            (
                root_model(extra_properties=(("swz_identity_key", Field("string", "must-not-be-here")),)),
                physical_model(0),
            ),
            "ROOT_SOURCE_PROVENANCE_FORBIDDEN",
        )
        expect_failure(executable, directory, "missing-swz-root",
            (physical_model(0, parent_index=None),), "ROOT_IDENTITY")
        expect_failure(
            executable, directory, "duplicate-swz-root",
            (root_model(), root_model(), physical_model(0, parent_index=0)), "ROOT_IDENTITY")
        expect_failure(
            executable, directory, "extra-synthetic-empty",
            (root_model(), physical_model(0), physical_model(1, has_mesh=False, name="SWZ_EXTRA")),
            "UNEXPECTED_NODE")
        expect_failure(executable, directory, "root-with-mesh",
            (root_model(has_mesh=True), physical_model(0)), "ROOT_IDENTITY")
        expect_failure(
            executable, directory, "root-invalid-parent",
            (root_model(parent_index=1), physical_model(0, parent_index=None)), "ROOT_IDENTITY")
        expect_failure(
            executable, directory, "root-nonidentity-transform",
            (root_model(translation=(1.0, 0.0, 0.0)), physical_model(0)), "ROOT_IDENTITY")
        expect_failure(
            executable, directory, "root-nonunit-scale",
            (root_model(scale=(2.0, 1.0, 1.0)), physical_model(0)), "HIDDEN_TRANSFORM_OR_SCALE")
        expect_failure(
            executable, directory, "provenance-free-physical-mesh",
            (root_model(), physical_model(0, source_object_id=None, identity_key=None)),
            "SOURCE_OBJECT_PROVENANCE_MISSING")
        expect_failure(
            executable, directory, "provenance-free-arbitrary-empty",
            (root_model(), physical_model(0, has_mesh=False, name="ARBITRARY_EMPTY")),
            "UNEXPECTED_NODE")
        print("PROVENANCE_CONTRACT_CASES=24")
        print("PROVENANCE_CONTRACT_RESULT=PASS")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: provenance_contract.py <compiled-validator>", file=sys.stderr)
        return 2
    executable = pathlib.Path(sys.argv[1]).resolve()
    if not executable.is_file():
        print("compiled validator executable is missing", file=sys.stderr)
        return 2
    try:
        run_matrix(executable)
    except Exception as error:
        print(f"provenance_contract.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
