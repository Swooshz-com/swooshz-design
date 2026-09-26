cmake_minimum_required(VERSION 3.20)
project(s8_process_runner C)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR NOT CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
  message(FATAL_ERROR "s8-process-runner is Linux x86_64-only by contract")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_executable(s8-process-runner src/runner.c)
target_compile_options(s8-process-runner PRIVATE -Wall -Wextra -Wpedantic -Werror)

enable_testing()
find_package(Threads REQUIRED)
add_executable(s8-process-runner-contract-tests tests/runner_contract.c)
target_compile_options(s8-process-runner-contract-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
target_link_libraries(s8-process-runner-contract-tests PRIVATE Threads::Threads)

set(S8_RUNNER_CASES
  ordinary_exec
  fork_denied
  vfork_denied
  clone_non_thread_denied
  clone3_enosys
  pthread_allowed
  x32_abi_rejected
  memory_limit
  file_limit
  timeout
  stdout_limit
  stderr_limit
  receipt_schema
  runner_sha256
  applied_rlimit_as
  applied_rlimit_fsize
  applied_timeout
  applied_output_caps
  max_children_zero
  seccomp_filter_installed
)

foreach(S8_CASE IN LISTS S8_RUNNER_CASES)
  add_test(NAME "s8-runner.${S8_CASE}" COMMAND s8-process-runner-contract-tests --case "${S8_CASE}" $<TARGET_FILE:s8-process-runner>)
endforeach()
