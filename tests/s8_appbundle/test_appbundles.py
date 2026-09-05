import ast
import pathlib
import unittest
import xml.etree.ElementTree as ET


ROOT = pathlib.Path(__file__).resolve().parents[2]
GEN_XML = ROOT / "aps" / "s8-max-generation.bundle" / "PackageContents.xml"
VAL_XML = ROOT / "aps" / "s8-max-validation.bundle" / "PackageContents.xml"
GEN = ROOT / "aps" / "s8-max-generation.bundle" / "Contents" / "s8_generate.py"
VAL = ROOT / "aps" / "s8-max-validation.bundle" / "Contents" / "s8_validate.py"


class S8AppBundleContractTests(unittest.TestCase):
    def test_package_manifests_are_native_python_entries(self):
        generation = ET.parse(GEN_XML).getroot()
        validation = ET.parse(VAL_XML).getroot()
        self.assertEqual(generation.attrib["Name"], "swooshz-s8-max-generation-v1")
        self.assertEqual(validation.attrib["Name"], "swooshz-s8-max-validation-v1")
        self.assertEqual(generation.find(".//ComponentEntry").attrib["ModuleName"], "./Contents/s8_generate.py")
        self.assertEqual(validation.find(".//ComponentEntry").attrib["ModuleName"], "./Contents/s8_validate.py")
        self.assertEqual(generation.find(".//RuntimeRequirements").attrib["Platform"], "3ds Max")
        self.assertEqual(validation.find(".//RuntimeRequirements").attrib["Platform"], "3ds Max")

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
        self.assertIn("rt.units.SystemScale = 1.0", source)
        self.assertIn('rt.units.DisplayType = rt.Name("Metric")', source)
        self.assertIn('rt.units.MetricType = rt.Name("Millimeters")', source)
        self.assertIn("node.transform = max_matrix(world)", source)
        self.assertNotIn("node.transform = max_matrix(local)", source)
        self.assertIn("rt.polyOp.createFace", source)
        self.assertIn('RECEIPT_NAME = "swooshz-s8-generation-receipt.json"', source)
        self.assertNotIn('RESULT_NAME = "s8-generation-result.json"', source)
        self.assertIn("clearNeedSaveFlag=True", source)
        self.assertIn("useNewFile=True", source)
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
        self.assertIn("allowPrompts=False", source)
        self.assertIn('missingExtFilesAction=rt.Name("abort")', source)
        self.assertIn('missingDLLsAction=rt.Name("abort")', source)
        self.assertIn('missingXRefsAction=rt.Name("abort")', source)
        self.assertIn("skipXRefs=False", source)
        self.assertIn("expected_manifest", source)
        self.assertIn("expected_manifest_hash", source)
        self.assertIn("derived_local", source)

    def test_no_secret_or_private_provider_values_are_bundled(self):
        for path in (GEN_XML, VAL_XML, GEN, VAL):
            source = path.read_text(encoding="utf-8").lower()
            self.assertNotIn("client_secret", source)
            self.assertNotIn("access_token", source)
            self.assertNotIn("signedurl", source)
            self.assertNotIn("authorization:", source)


if __name__ == "__main__":
    unittest.main()
