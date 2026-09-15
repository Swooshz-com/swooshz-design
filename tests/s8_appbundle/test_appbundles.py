import ast
import pathlib
import unittest
import uuid
import xml.etree.ElementTree as ET


ROOT = pathlib.Path(__file__).resolve().parents[2]
GEN_XML = ROOT / "aps" / "s8-max-generation.bundle" / "PackageContents.xml"
VAL_XML = ROOT / "aps" / "s8-max-validation.bundle" / "PackageContents.xml"
GEN = ROOT / "aps" / "s8-max-generation.bundle" / "Contents" / "s8_generate.py"
VAL = ROOT / "aps" / "s8-max-validation.bundle" / "Contents" / "s8_validate.py"

EXPECTED_UPGRADE_CODES = {
    GEN_XML: "{D6B2C8A4-4E1F-4F9D-8A73-5C0E1B2D9F40}",
    VAL_XML: "{A7C3D9B5-5F20-4A8E-9B64-6D1F2C3E8A51}",
}


class S8AppBundleContractTests(unittest.TestCase):
    def validator_dependency_functions(self):
        source = VAL.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(VAL))
        selected = [
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name in {
                "fail",
                "external_file_dependencies",
                "validate_external_dependencies",
            }
        ]
        namespace = {}
        exec(
            compile(ast.Module(body=selected, type_ignores=[]), str(VAL), "exec"),
            namespace,
        )
        return namespace["validate_external_dependencies"]

    class DependencyRuntime:
        class XRefs:
            def __init__(self, count):
                self.count = count

            def getXRefFileCount(self):
                return self.count

        class TextureMaps:
            classes = ("ai_imager_denoiser_oidn",)

        TextureMap = TextureMaps()

        def __init__(self, *, xrefs=0, files=(), enumeration_error=None):
            self.xrefs = self.XRefs(xrefs)
            self.files = files
            self.enumeration_error = enumeration_error
            self.enumerated = False

        def Array(self):
            return []

        def execute(self, _source):
            return lambda filename, output: output.append(filename)

        def enumerateFiles(self, collector, output):
            self.enumerated = True
            if self.enumeration_error is not None:
                raise self.enumeration_error
            for filename in self.files:
                collector(filename, output)

        def getClassInstances(self, _texture_map_class):
            raise AssertionError("untargeted TextureMap enumeration must not run")

    def assert_resource_manifest(
        self,
        path,
        expected_name,
        expected_description,
        expected_script,
    ):
        root = ET.parse(path).getroot()
        self.assertEqual(root.tag, "ApplicationPackage")
        self.assertEqual(root.attrib["SchemaVersion"], "1.0")
        self.assertEqual(root.attrib["AutodeskProduct"], "3ds Max")
        self.assertEqual(root.attrib["ProductType"], "Application")
        self.assertEqual(root.attrib["Name"], expected_name)
        self.assertEqual(root.attrib["Description"], expected_description)
        self.assertEqual(root.attrib["Author"], "Swooshz Design")
        self.assertEqual(root.attrib["AppVersion"], "1.0.0")
        company_details = root.findall("./CompanyDetails")
        self.assertEqual(len(company_details), 1)
        self.assertEqual(
            company_details[0].attrib,
            {
                "Name": "Swooshz Design",
                "Url": "https://swooshz.design",
                "Email": "support@swooshz.design",
            },
        )

        upgrade_code = root.attrib.get("UpgradeCode")
        self.assertIsNotNone(upgrade_code)
        uuid.UUID(upgrade_code.strip("{}"))
        self.assertEqual(upgrade_code, EXPECTED_UPGRADE_CODES[path])

        components = root.findall(".//Components")
        self.assertEqual(len(components), 0)
        self.assertEqual(len(root.findall(".//ComponentEntry")), 0)
        self.assertFalse(any(component.attrib.get("Description") for component in components))
        forbidden_tags = {
            "ComponentEntry",
            "Components",
            "DependentBundles",
            "EnvironmentVariables",
            "LoadAfterBundles",
        }
        self.assertFalse(any(element.tag in forbidden_tags for element in root.iter()))
        self.assertTrue((path.parent / "Contents" / expected_script).is_file())

    def test_generation_manifest_is_a_resource_only_native_package(self):
        self.assert_resource_manifest(
            GEN_XML,
            "swooshz-s8-max-generation-v1",
            "Swooshz S8 deterministic editable Max scene generation",
            "s8_generate.py",
        )

    def test_validation_manifest_is_a_resource_only_native_package(self):
        self.assert_resource_manifest(
            VAL_XML,
            "swooshz-s8-max-validation-v1",
            "Swooshz S8 independent native Max scene validation",
            "s8_validate.py",
        )

    def test_generation_and_validation_upgrade_codes_are_distinct(self):
        self.assertNotEqual(EXPECTED_UPGRADE_CODES[GEN_XML], EXPECTED_UPGRADE_CODES[VAL_XML])

    def test_sources_parse_without_importing_pymxs(self):
        for path in (GEN, VAL):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            imports = [node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
            self.assertTrue(any(node.module == "pymxs" for node in imports))
            self.assertFalse(any(node.module in {"requests", "urllib", "socket", "subprocess"} for node in imports))

    def test_generation_contract_is_native_and_fail_closed(self):
        source = GEN.read_text(encoding="utf-8")
        self.assertIn("from pymxs import runtime as rt", source)
        self.assertIn("rt.saveMaxFile", source)
        self.assertIn("rt.convertTo(node, rt.Editable_Poly)", source)
        self.assertIn("rt.Physical_Material()", source)
        self.assertIn('ROUND_SEGMENTS = 24', source)
        self.assertIn('OUTPUT_NAME = "swooshz-s8-model.max"', source)
        self.assertIn('ARTIFACT_ID_NAME = "s8-artifact-id.txt"', source)
        self.assertIn("S8_OUTPUT_EXISTS", source)
        self.assertNotIn("FBX", source)
        self.assertNotIn("USD", source)
        self.assertNotIn("MaxUSD", source)
        self.assertIn('value == "latest"', source)
        self.assertNotIn(".NET", source)
        self.assertNotIn("requests", source)

    def test_generation_runtime_contract_uses_exact_units_transforms_topology_and_io(self):
        source = GEN.read_text(encoding="utf-8")
        self.assertIn('rt.units.SystemType = rt.Name("Millimeters")', source)
        self.assertNotIn('rt.units.SystemType = rt.Name("Metric")', source)
        self.assertIn("rt.units.SystemScale = 1.0", source)
        self.assertIn('rt.units.DisplayType = rt.Name("Metric")', source)
        self.assertIn('rt.units.MetricType = rt.Name("Millimeters")', source)
        self.assertIn("node.transform = max_matrix(world)", source)
        self.assertNotIn("node.transform = max_matrix(local)", source)
        self.assertIn("rt.polyOp.deleteFaces(node, rt.Array(1), delIsoVerts=False)", source)
        self.assertIn("world = compose(local, world_by_id[parent_id])", source)
        self.assertLess(source.index("node.parent = parent_node"), source.index("node.transform = max_matrix(world)"))
        self.assertNotIn("rt.polyOp.createFace", source)
        self.assertIn("node.EditablePoly.createFace(rt.Array(*expected_vertices))", source)
        self.assertIn("node.EditablePoly.GetNumFaces()", source)
        self.assertIn("node.EditablePoly.GetFaceDegree(face_index)", source)
        self.assertIn("node.EditablePoly.GetFaceVertex(face_index, corner)", source)
        self.assertIn('S8_MESH_FACE_CREATE_FAILED', source)
        self.assertIn('RECEIPT_NAME = "swooshz-s8-generation-receipt.json"', source)
        self.assertIn('BINDING_NAME = "s8-engine-binding.json"', source)
        self.assertIn('ARTIFACT_ID_NAME = "s8-artifact-id.txt"', source)
        self.assertNotIn('RESULT_NAME = "s8-generation-result.json"', source)
        self.assertIn("clearNeedSaveFlag=True", source)
        self.assertIn("useNewFile=True", source)
        self.assertIn("quiet=True", source)
        self.assertNotIn("EXPECTED_MANIFEST_NAME", source)
        self.assertNotIn('EXPECTED_MANIFEST_HASH_NAME = "expectedManifestSha256"', source)

    def test_validation_contract_is_a_separate_fresh_native_readback(self):
        source = VAL.read_text(encoding="utf-8")
        self.assertIn("rt.resetMaxFile", source)
        self.assertIn("rt.loadMaxFile", source)
        self.assertIn("Editable_Poly", source)
        self.assertIn("Physical", source)
        self.assertIn("s8-max-readback-v1", source)
        self.assertIn("no-xrefs-textures-missing-dependencies", source)
        self.assertIn('EXPECTED_MANIFEST_NAME = "swooshz-s8-expected-manifest.json"', source)
        self.assertIn('EXPECTED_MANIFEST_HASH_NAME = "expectedManifestSha256"', source)
        self.assertNotIn("FBX", source)
        self.assertNotIn("USD", source)
        self.assertNotIn("MaxUSD", source)
        self.assertIn('value == "latest"', source)
        self.assertNotIn("requests", source)

    def test_validation_runtime_contract_is_exact_and_manifest_independent(self):
        source = VAL.read_text(encoding="utf-8")
        self.assertIn('EXPECTED_MANIFEST_NAME = "swooshz-s8-expected-manifest.json"', source)
        self.assertIn('EXPECTED_MANIFEST_HASH_NAME = "expectedManifestSha256"', source)
        self.assertIn('READBACK_NAME = "swooshz-s8-validation-readback.json"', source)
        self.assertNotIn('READBACK_NAME = "s8-max-readback.json"', source)
        self.assertIn("useFileUnits=True", source)
        tree = ast.parse(source, filename=str(VAL))
        load_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "rt"
            and node.func.attr == "loadMaxFile"
        ]
        self.assertEqual(len(load_calls), 1)
        self.assertEqual(len(load_calls[0].args), 1)
        self.assertEqual(
            [keyword.arg for keyword in load_calls[0].keywords],
            ["useFileUnits", "quiet"],
        )
        self.assertIn("expected_manifest", source)
        self.assertIn("expected_manifest_hash", source)
        self.assertIn("world_matrix = matrix(node.transform)", source)
        self.assertIn("parent_world = matrix(actual_parent.transform)", source)
        self.assertIn("derived_local", source)
        self.assertIn('"localTransform": derived_local', source)
        self.assertIn('"worldTransform": world_matrix', source)
        self.assertIn("def max_name(value):", source)
        self.assertIn('max_name(rt.units.SystemType) != "millimeters"', source)
        self.assertNotIn('"millimeter" not in str(rt.units.SystemType).lower()', source)
        self.assertIn('degradation_value.split(",")', source)
        self.assertNotIn('"degradationCodes": [user_prop(node, "s8.degradationCode")]', source)
        self.assertNotIn('expected_codes = [",".join(expected["degradationCodes"])]', source)

    def test_validation_external_dependency_check_rejects_xrefs(self):
        validate = self.validator_dependency_functions()
        runtime = self.DependencyRuntime(xrefs=1)
        with self.assertRaisesRegex(RuntimeError, "^S8_EXTERNAL_DEPENDENCY$"):
            validate(runtime)
        self.assertFalse(runtime.enumerated)

    def test_validation_external_dependency_check_rejects_scene_files(self):
        validate = self.validator_dependency_functions()
        for filename in ("texture.png", "missing-texture.png"):
            with self.subTest(filename=filename):
                runtime = self.DependencyRuntime(files=(filename,))
                with self.assertRaisesRegex(RuntimeError, "^S8_EXTERNAL_DEPENDENCY$"):
                    validate(runtime)
                self.assertTrue(runtime.enumerated)

    def test_validation_external_dependency_check_ignores_non_file_runtime_maps(self):
        validate = self.validator_dependency_functions()
        runtime = self.DependencyRuntime()
        validate(runtime)
        self.assertTrue(runtime.enumerated)

    def test_validation_external_dependency_check_fails_closed_on_enumeration_error(self):
        validate = self.validator_dependency_functions()
        runtime = self.DependencyRuntime(enumeration_error=RuntimeError("unresolved"))
        with self.assertRaisesRegex(RuntimeError, "^S8_EXTERNAL_DEPENDENCY$"):
            validate(runtime)

    def test_validation_external_dependency_check_cannot_regress_to_texturemap_scan(self):
        source = VAL.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(VAL))
        attributes = {
            node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
        }
        self.assertNotIn("getClassInstances", attributes)
        self.assertNotIn("TextureMap", attributes)
        self.assertIn("enumerateFiles", attributes)
        self.assertIn('fail("S8_EXTERNAL_DEPENDENCY")', source)

    def test_no_secret_or_private_provider_values_are_bundled(self):
        for path in (GEN_XML, VAL_XML, GEN, VAL):
            source = path.read_text(encoding="utf-8").lower()
            self.assertNotIn("client_secret", source)
            self.assertNotIn("access_token", source)
            self.assertNotIn("signedurl", source)
            self.assertNotIn("authorization:", source)


if __name__ == "__main__":
    unittest.main()
