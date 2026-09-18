#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ufbx.h"

#define ARTIFACT_MAX (128u * 1024u * 1024u)
#define TEMP_MEMORY_MAX (256u * 1024u * 1024u)
#define RESULT_MEMORY_MAX (512u * 1024u * 1024u)
#define NODE_DEPTH_MAX 256u

static int fail(const char *code)
{
    fprintf(stderr, "S8_VALIDATOR_FAIL:%s\n", code);
    return 1;
}

static void json_string(ufbx_string value)
{
    putchar('"');
    for (size_t i = 0; i < value.length; i++) {
        unsigned char c = (unsigned char)value.data[i];
        if (c == '"' || c == '\\') { putchar('\\'); putchar((int)c); }
        else if (c >= 0x20 && c <= 0x7e) putchar((int)c);
        else printf("\\u%04x", (unsigned)c);
    }
    putchar('"');
}

static int near_value(double left, double right, double tolerance)
{
    return fabs(left - right) <= tolerance;
}

static int matrix_identity(ufbx_matrix matrix)
{
    const double expected[12] = { 1,0,0, 0,1,0, 0,0,1, 0,0,0 };
    for (size_t i = 0; i < 12; i++) if (!near_value(matrix.v[i], expected[i], 1e-9)) return 0;
    return 1;
}

static int transform_scale_is_one(ufbx_transform transform)
{
    return near_value(transform.scale.x, 1.0, 1e-9) && near_value(transform.scale.y, 1.0, 1e-9) && near_value(transform.scale.z, 1.0, 1e-9);
}

static ufbx_string required_string_prop(ufbx_node *node, const char *name)
{
    ufbx_prop *prop = ufbx_find_prop(&node->props, name);
    if (!prop || !(prop->flags & UFBX_PROP_FLAG_VALUE_STR) || !prop->value_str.length || prop->value_str.length > 128) {
        ufbx_string empty = { 0 };
        return empty;
    }
    return prop->value_str;
}

static int validate_profile(ufbx_scene *scene)
{
    if (scene->metadata.file_format != UFBX_FILE_FORMAT_FBX || scene->metadata.ascii || scene->metadata.version != 7400) return fail("FBX_HEADER_PROFILE");
    if (scene->metadata.warnings.count != 0) return fail("PARSER_WARNING_OR_REPAIR");
    if (!near_value(scene->settings.unit_meters, 0.001, 1e-9) || !near_value(scene->settings.original_unit_meters, 0.001, 1e-9)) return fail("WRONG_UNITS");
    if (scene->settings.axes.right != UFBX_COORDINATE_AXIS_POSITIVE_X || scene->settings.axes.up != UFBX_COORDINATE_AXIS_POSITIVE_Z || scene->settings.axes.front != UFBX_COORDINATE_AXIS_NEGATIVE_Y) return fail("WRONG_AXES");
    if (scene->cameras.count || scene->lights.count || scene->bones.count || scene->textures.count || scene->videos.count || scene->audio_clips.count || scene->audio_layers.count) return fail("PROHIBITED_MEDIA_OR_SCENE_OBJECT");
    if (scene->anim_curves.count || scene->anim_values.count || scene->skin_deformers.count || scene->blend_deformers.count || scene->cache_deformers.count || scene->constraints.count || scene->procedural_geometries.count || scene->nurbs_curves.count || scene->nurbs_surfaces.count) return fail("PROHIBITED_FEATURE");
    if (scene->metadata.filename.length || scene->metadata.relative_root.length || scene->texture_files.count) return fail("EXTERNAL_PATH_OR_REFERENCE");
    size_t root_count = 0;
    for (size_t i = 0; i < scene->nodes.count; i++) {
        ufbx_node *node = scene->nodes.data[i];
        if (node->name.length == 8 && !memcmp(node->name.data, "SWZ_ROOT", 8)) root_count++;
        if (node->is_geometry_transform_helper || node->is_scale_helper || node->has_geometry_transform || node->use_rotation_space || node->has_adjust_transform) return fail("HIDDEN_TRANSFORM");
        if (!matrix_identity(node->geometry_to_node) || !transform_scale_is_one(node->local_transform)) return fail("HIDDEN_TRANSFORM_OR_SCALE");
        if (node->mesh) {
            ufbx_mesh *mesh = node->mesh;
            if (mesh->generated_normals || !mesh->vertex_normal.exists) return fail("MISSING_OR_GENERATED_NORMALS");
            if (mesh->uv_sets.count || mesh->color_sets.count || mesh->vertex_uv.exists || mesh->vertex_color.exists) return fail("PROHIBITED_VERTEX_ATTRIBUTES");
            if (mesh->skin_deformers.count || mesh->blend_deformers.count || mesh->cache_deformers.count) return fail("PROHIBITED_DEFORMER");
            for (size_t face_ix = 0; face_ix < mesh->faces.count; face_ix++) if (mesh->faces.data[face_ix].num_indices != 3) return fail("NON_TRIANGLE_FACE");
        }
    }
    if (root_count != 1) return fail("ROOT_IDENTITY");
    return 0;
}

static void print_matrix(ufbx_matrix matrix)
{
    putchar('[');
    for (size_t i = 0; i < 12; i++) { if (i) putchar(','); printf("%.17g", (double)matrix.v[i]); }
    putchar(']');
}

static void print_vec3(ufbx_vec3 value)
{
    printf("[%.17g,%.17g,%.17g]", (double)value.x, (double)value.y, (double)value.z);
}

static void print_scene(ufbx_scene *scene)
{
    ufbx_node *root = NULL;
    for (size_t node_ix = 0; node_ix < scene->nodes.count; node_ix++) {
        ufbx_node *node = scene->nodes.data[node_ix];
        if (node->name.length == 8 && !memcmp(node->name.data, "SWZ_ROOT", 8)) { root = node; break; }
    }
    ufbx_string revision_id = required_string_prop(root, "swz_revisionId");
    ufbx_string revision_hash = required_string_prop(root, "swz_revisionHash");
    ufbx_string validation_hash = required_string_prop(root, "swz_s6ValidationHash");
    ufbx_string handoff_digest = required_string_prop(root, "swz_s6HandoffDigest");
    printf("{\"schemaVersion\":\"s8-ufbx-readback-v1\",\"fbxVersion\":%u,\"unitMeters\":%.17g,\"warningCount\":%zu,\"source\":{\"revisionId\":", scene->metadata.version, (double)scene->settings.unit_meters, scene->metadata.warnings.count);
    json_string(revision_id);
    printf(",\"revisionHash\":"); json_string(revision_hash);
    printf(",\"s6ValidationHash\":"); json_string(validation_hash);
    printf(",\"s6HandoffDigest\":"); json_string(handoff_digest);
    printf("},\"materials\":[");
    for (size_t material_ix = 0; material_ix < scene->materials.count; material_ix++) {
        ufbx_material *material = scene->materials.data[material_ix];
        if (material_ix) putchar(',');
        printf("{\"name\":"); json_string(material->name);
        printf(",\"shadingModel\":"); json_string(material->shading_model_name);
        printf(",\"diffuse\":"); print_vec3(material->fbx.diffuse_color.value_vec3);
        printf(",\"diffuseFactor\":%.17g,\"transparencyFactor\":%.17g,\"specularFactor\":%.17g,\"reflectionFactor\":%.17g,\"emissionFactor\":%.17g,\"ambientFactor\":%.17g,\"textureCount\":%zu}",
            (double)material->fbx.diffuse_factor.value_real,
            (double)material->fbx.transparency_factor.value_real,
            (double)material->fbx.specular_factor.value_real,
            (double)material->fbx.reflection_factor.value_real,
            (double)material->fbx.emission_factor.value_real,
            (double)material->fbx.ambient_factor.value_real,
            material->textures.count);
    }
    printf("],\"nodes\":[");
    int first_node = 1;
    for (size_t node_ix = 0; node_ix < scene->nodes.count; node_ix++) {
        ufbx_node *node = scene->nodes.data[node_ix];
        if (node->is_root) continue;
        if (!first_node) putchar(',');
        first_node = 0;
        printf("{\"name\":"); json_string(node->name);
        printf(",\"parent\":");
        if (node->parent && !node->parent->is_root) json_string(node->parent->name); else printf("null");
        printf(",\"nodeToParent\":"); print_matrix(node->node_to_parent);
        printf(",\"nodeToWorld\":"); print_matrix(node->node_to_world);
        printf(",\"mesh\":");
        if (!node->mesh) { printf("null}"); continue; }
        ufbx_mesh *mesh = node->mesh;
        printf("{\"vertices\":[");
        for (size_t vertex_ix = 0; vertex_ix < mesh->vertices.count; vertex_ix++) { if (vertex_ix) putchar(','); print_vec3(mesh->vertices.data[vertex_ix]); }
        printf("],\"triangles\":[");
        for (size_t face_ix = 0; face_ix < mesh->faces.count; face_ix++) {
            ufbx_face face = mesh->faces.data[face_ix];
            if (face_ix) putchar(',');
            printf("[%u,%u,%u]", mesh->vertex_indices.data[face.index_begin], mesh->vertex_indices.data[face.index_begin + 1], mesh->vertex_indices.data[face.index_begin + 2]);
        }
        printf("],\"cornerNormals\":[");
        for (size_t index_ix = 0; index_ix < mesh->num_indices; index_ix++) { if (index_ix) putchar(','); print_vec3(ufbx_get_vertex_vec3(&mesh->vertex_normal, index_ix)); }
        printf("],\"materialNames\":[");
        for (size_t mat_ix = 0; mat_ix < node->materials.count; mat_ix++) { if (mat_ix) putchar(','); json_string(node->materials.data[mat_ix]->name); }
        printf("]}}");
    }
    printf("]}\n");
}

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--self-test")) {
        puts("ufbx=v0.23.0 commit=fcc5d6ba444cfd3eb80677dba5e37e493941abe5 tree=f99a3b0e775053f91ea16494d7b7be5102812d32");
        return 0;
    }
    if (argc != 2) return fail("USAGE");
    FILE *file = fopen(argv[1], "rb");
    if (!file) return fail("OPEN");
    if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return fail("SEEK"); }
    long length = ftell(file);
    if (length <= 27 || (unsigned long)length > ARTIFACT_MAX) { fclose(file); return fail("SIZE"); }
    if (fseek(file, 0, SEEK_SET) != 0) { fclose(file); return fail("SEEK"); }
    unsigned char *data = (unsigned char*)malloc((size_t)length);
    if (!data) { fclose(file); return fail("MEMORY"); }
    if (fread(data, 1, (size_t)length, file) != (size_t)length) { free(data); fclose(file); return fail("READ"); }
    fclose(file);
    static const unsigned char binary_header[] = "Kaydara FBX Binary  \x00\x1a\x00";
    if (memcmp(data, binary_header, sizeof(binary_header) - 1) || data[23] != 0xe8 || data[24] != 0x1c || data[25] != 0 || data[26] != 0) { free(data); return fail("FBX_HEADER_PROFILE"); }
    ufbx_load_opts opts = { 0 };
    opts.temp_allocator.memory_limit = TEMP_MEMORY_MAX;
    opts.result_allocator.memory_limit = RESULT_MEMORY_MAX;
    opts.strict = true;
    opts.disable_quirks = true;
    opts.load_external_files = false;
    opts.ignore_missing_external_files = false;
    opts.generate_missing_normals = false;
    opts.allow_unsafe = false;
    opts.connect_broken_elements = false;
    opts.allow_nodes_out_of_root = false;
    opts.allow_missing_vertex_position = false;
    opts.allow_empty_faces = false;
    opts.node_depth_limit = NODE_DEPTH_MAX;
    opts.geometry_transform_handling = UFBX_GEOMETRY_TRANSFORM_HANDLING_PRESERVE;
    opts.inherit_mode_handling = UFBX_INHERIT_MODE_HANDLING_PRESERVE;
    opts.pivot_handling = UFBX_PIVOT_HANDLING_RETAIN;
    ufbx_error error;
    ufbx_scene *scene = ufbx_load_memory(data, (size_t)length, &opts, &error);
    free(data);
    if (!scene) { fprintf(stderr, "S8_VALIDATOR_FAIL:PARSE:%s\n", error.description.data); return 1; }
    int result = validate_profile(scene);
    if (!result) print_scene(scene);
    ufbx_free_scene(scene);
    return result;
}
