cmake_minimum_required(VERSION 3.20)
project(s8_fbx_validator C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(ufbx STATIC vendor/ufbx/ufbx.c)
target_include_directories(ufbx PUBLIC vendor/ufbx)
target_compile_definitions(ufbx PRIVATE
  UFBX_NO_STDIO=1
  UFBX_NO_FORMAT_OBJ=1
  UFBX_NO_GEOMETRY_CACHE=1
  UFBX_ENABLE_ERROR_STACK=1
)
if(MSVC)
  target_compile_options(ufbx PRIVATE /W4)
else()
  target_compile_options(ufbx PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(s8-fbx-validator src/validator.c)
target_link_libraries(s8-fbx-validator PRIVATE ufbx)
if(NOT MSVC)
  target_link_libraries(s8-fbx-validator PRIVATE m)
endif()

enable_testing()
add_test(NAME s8-fbx-validator-self-test COMMAND s8-fbx-validator --self-test)

add_executable(s8-validator-contract-tests tests/validator_contract.c)
add_test(NAME s8-validator-contract-tests COMMAND s8-validator-contract-tests)
