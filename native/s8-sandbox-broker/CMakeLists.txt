cmake_minimum_required(VERSION 3.20)
project(s8_sandbox_broker C)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR NOT CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
  message(FATAL_ERROR "s8-sandbox-broker is Linux x86_64-only by contract")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_executable(s8-sandbox-broker src/broker.c)
target_compile_options(s8-sandbox-broker PRIVATE -Wall -Wextra -Wpedantic -Werror -fno-common -fstack-protector-strong -D_FORTIFY_SOURCE=2)

add_executable(s8-sandbox-broker-contract src/broker.c)
target_compile_definitions(s8-sandbox-broker-contract PRIVATE S8_BROKER_CONTRACT_TEST=1)
target_compile_options(s8-sandbox-broker-contract PRIVATE -Wall -Wextra -Wpedantic -Werror -fno-common -fstack-protector-strong -D_FORTIFY_SOURCE=2)

enable_testing()
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_test(NAME s8-broker.contract COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/broker_contract.py" "$<TARGET_FILE:s8-sandbox-broker-contract>" "$<TARGET_FILE:s8-sandbox-broker>")
