cmake_minimum_required(VERSION 3.20)
project(s8_process_runner C)

if(WIN32)
  message(FATAL_ERROR "s8-process-runner is Linux-only by contract")
endif()

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_executable(s8-process-runner src/runner.c)
target_compile_options(s8-process-runner PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_executable(s8-process-runner-contract-tests tests/runner_contract.c)
target_compile_options(s8-process-runner-contract-tests PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME s8-process-runner-contract-tests COMMAND s8-process-runner-contract-tests $<TARGET_FILE:s8-process-runner>)
