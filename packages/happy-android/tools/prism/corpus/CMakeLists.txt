cmake_minimum_required(VERSION 3.20)
project(demo LANGUAGES CXX)
# comment
set(CMAKE_CXX_STANDARD 17)
add_executable(app src/main.cpp)
if(WIN32)
  target_compile_definitions(app PRIVATE "WINDOWS=1")
endif()
