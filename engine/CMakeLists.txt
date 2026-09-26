cmake_minimum_required(VERSION 3.16)
project(uhexen2_web VERSION 1.5.10 LANGUAGES C)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "This fork only supports the Emscripten iOS-PWA target")
endif()

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

set(ENGINE_TOP ${CMAKE_CURRENT_SOURCE_DIR})
set(COMMONDIR ${ENGINE_TOP}/h2shared)
set(UHEXEN2_TOP ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(UHEXEN2_SHARED ${UHEXEN2_TOP}/common)

option(USE_DEBUG "Debug build" OFF)
option(USE_SOUND "Enable the browser audio backend" ON)
# Ogg Vorbis music. This is the one codec that needs an Emscripten port
# (zlib-licensed libogg + libvorbis), which emcc fetches over the network the
# first time it is built. Turn it OFF for a network-less build with a cold
# EM_CACHE; the engine then still plays wav/mp3/flac music.
option(USE_CODEC_VORBIS "Decode Ogg Vorbis music via the Emscripten vorbis port" ON)
set(GAME_DATA_DIR "" CACHE PATH "Optional game data directory to preload")

# Renderer selection. "webgpu" is WebGlideNitro, the primary shipping
# configuration. "software" keeps the parked classic 8bpp rasterizer available
# and presents its indexed framebuffer through WebGPU.
# See docs/web/SOFTWARE_RENDERER.md, docs/web/WEBGLIDE_NITRO.md and
# docs/web/ARCHITECTURE.md.
set(WEB_RENDERER "webgpu" CACHE STRING "Web renderer: software or webgpu")
set_property(CACHE WEB_RENDERER PROPERTY STRINGS software webgpu)
if(NOT WEB_RENDERER STREQUAL "software" AND NOT WEB_RENDERER STREQUAL "webgpu")
    message(FATAL_ERROR "WEB_RENDERER must be 'software' or 'webgpu' (got '${WEB_RENDERER}')")
endif()
message(STATUS "Web renderer: ${WEB_RENDERER}")

add_compile_options(
    -Wall
    -Wextra
    -Wno-unused-parameter
    -Wno-unused-result
    -Wno-missing-field-initializers
)

if(USE_DEBUG)
    add_compile_options(-O0 -g)
    add_compile_definitions(DEBUG=1 DEBUG_BUILD=1)
else()
    add_compile_options(-O2 -DNDEBUG=1 -ffast-math)
endif()

add_compile_definitions(
    WEBQUAKE
    PLATFORM_WEB
    NO_SPLASHES
    __EMSCRIPTEN__
)

include_directories(
    ${ENGINE_TOP}/hexen2
    ${COMMONDIR}
    ${UHEXEN2_SHARED}
)

set(RENDERER_SOURCES
    ${ENGINE_TOP}/hexen2/r_part.c
    ${COMMONDIR}/screen.c
    ${COMMONDIR}/web_perf.c
)

if(WEB_RENDERER STREQUAL "webgpu")
    # WebGlideNitro owns a native WebGPU rendering path.
    # gl_refrag.c is here because efrags are renderer-agnostic and the
    # software r_efrag.c is not (it reaches into the surface cache).
    add_compile_definitions(WEBGPUQUAKE)
    list(APPEND RENDERER_SOURCES
        ${COMMONDIR}/nitro_model.c
        ${ENGINE_TOP}/hexen2/r_webgpu.c
        ${COMMONDIR}/draw_webgpu.c
        ${COMMONDIR}/wgpu_world.c
        ${COMMONDIR}/wgpu_lightvol.c
        ${COMMONDIR}/wgpu_entity.c
        ${COMMONDIR}/gl_fog.c
        ${COMMONDIR}/gl_refrag.c
    )
else()
    add_compile_definitions(WEBSOFT WEBGPU_PRESENT)
    list(APPEND RENDERER_SOURCES
        ${COMMONDIR}/model.c
        ${ENGINE_TOP}/hexen2/r_alias.c
        ${ENGINE_TOP}/hexen2/r_main.c
        ${ENGINE_TOP}/hexen2/r_misc.c
        ${ENGINE_TOP}/hexen2/r_soft_web.c
        ${COMMONDIR}/d_edge.c
        ${COMMONDIR}/d_fill.c
        ${COMMONDIR}/d_init.c
        ${COMMONDIR}/d_modech.c
        ${COMMONDIR}/d_part.c
        ${COMMONDIR}/d_polyse.c
        ${COMMONDIR}/d_scan.c
        ${COMMONDIR}/d_sky.c
        ${COMMONDIR}/d_sprite.c
        ${COMMONDIR}/d_surf.c
        ${COMMONDIR}/d_vars.c
        ${COMMONDIR}/d_zpoint.c
        ${COMMONDIR}/r_aclip.c
        ${COMMONDIR}/r_bsp.c
        ${COMMONDIR}/r_draw.c
        ${COMMONDIR}/r_edge.c
        ${COMMONDIR}/r_efrag.c
        ${COMMONDIR}/r_light.c
        ${COMMONDIR}/r_sky.c
        ${COMMONDIR}/r_sprite.c
        ${COMMONDIR}/r_surf.c
        ${COMMONDIR}/r_vars.c
        ${COMMONDIR}/draw.c
        ${COMMONDIR}/draw_soft_web.c
    )
endif()

set(CLIENT_SOURCES
    ${ENGINE_TOP}/hexen2/cl_demo.c
    ${ENGINE_TOP}/hexen2/cl_effect.c
    ${ENGINE_TOP}/hexen2/cl_inlude.c
    ${ENGINE_TOP}/hexen2/cl_input.c
    ${ENGINE_TOP}/hexen2/cl_main.c
    ${ENGINE_TOP}/hexen2/cl_parse.c
    ${ENGINE_TOP}/hexen2/cl_string.c
    ${ENGINE_TOP}/hexen2/cl_tent.c
    ${ENGINE_TOP}/hexen2/cl_cmd.c
    ${ENGINE_TOP}/hexen2/console.c
    ${ENGINE_TOP}/hexen2/keys.c
    ${ENGINE_TOP}/hexen2/menu.c
    ${ENGINE_TOP}/hexen2/sbar.c
    ${ENGINE_TOP}/hexen2/view.c
    ${ENGINE_TOP}/hexen2/chase.c
    ${ENGINE_TOP}/hexen2/cl_csqc.c
    ${COMMONDIR}/pr_csqc.c
)

set(COMMON_SOURCES
    ${ENGINE_TOP}/hexen2/host.c
    ${ENGINE_TOP}/hexen2/host_cmd.c
    ${ENGINE_TOP}/hexen2/host_async.c
    ${ENGINE_TOP}/hexen2/sv_main.c
    ${ENGINE_TOP}/hexen2/sv_phys.c
    ${ENGINE_TOP}/hexen2/sv_user.c
    ${ENGINE_TOP}/hexen2/sv_effect.c
    ${ENGINE_TOP}/hexen2/sv_move.c
    ${ENGINE_TOP}/hexen2/world.c
    ${ENGINE_TOP}/hexen2/net_main.c
    ${ENGINE_TOP}/hexen2/net_loop.c
    ${ENGINE_TOP}/hexen2/net_web.c
    ${COMMONDIR}/cmd.c
    ${COMMONDIR}/cvar.c
    ${COMMONDIR}/pr_cmds.c
    ${COMMONDIR}/pr_edict.c
    ${COMMONDIR}/pr_exec.c
    ${COMMONDIR}/mathlib.c
    ${COMMONDIR}/sizebuf.c
    ${COMMONDIR}/link_ops.c
    ${COMMONDIR}/hashindex.c
    ${COMMONDIR}/zone.c
    ${COMMONDIR}/quakefs.c
    ${COMMONDIR}/debuglog.c
    ${COMMONDIR}/host_string.c
    ${COMMONDIR}/cfgfile.c
    ${COMMONDIR}/common.c
    ${COMMONDIR}/wad.c
    ${COMMONDIR}/msg_io.c
    ${UHEXEN2_SHARED}/qsnprint.c
    ${UHEXEN2_SHARED}/strlcat.c
    ${UHEXEN2_SHARED}/strlcpy.c
    ${UHEXEN2_SHARED}/q_endian.c
    ${UHEXEN2_SHARED}/crc.c
)

if(USE_SOUND)
    # Music codecs. bgmusic.c only offers a format whose codec registered
    # itself in S_CodecInit, so a codec that is not listed here is silently
    # unavailable at runtime ("BGM: stream codecs: ..." reports the live set).
    #
    # wav/mp3/flac decode through the vendored public-domain dr_libs headers
    # in h2shared, so they cost nothing but compile time. Vorbis needs the
    # Emscripten port (see USE_CODEC_VORBIS above). Opus (opusfile) and the
    # tracker formats (libxmp) have no Emscripten port and stay out.
    set(SOUND_SOURCES
        ${COMMONDIR}/snd_sys.c
        ${COMMONDIR}/snd_dma.c
        ${COMMONDIR}/snd_mix.c
        ${COMMONDIR}/snd_mem.c
        ${COMMONDIR}/snd_wave.c
        ${COMMONDIR}/snd_flac.c
        ${COMMONDIR}/snd_mp3.c
        ${COMMONDIR}/snd_mp3tag.c
        ${COMMONDIR}/snd_codec.c
        ${COMMONDIR}/snd_web.c
        ${COMMONDIR}/bgmusic.c
    )
    add_compile_definitions(HAVE_WEB_SOUND=1 USE_CODEC_MP3 USE_CODEC_FLAC)
    if(USE_CODEC_VORBIS)
        list(APPEND SOUND_SOURCES ${COMMONDIR}/snd_vorbis.c)
        add_compile_definitions(USE_CODEC_VORBIS)
        set(VORBIS_STATUS " ogg")
    else()
        set(VORBIS_STATUS " (ogg disabled: USE_CODEC_VORBIS=OFF)")
    endif()
    message(STATUS "Music codecs: wav mp3 flac${VORBIS_STATUS}")
else()
    set(SOUND_SOURCES ${COMMONDIR}/snd_null.c ${COMMONDIR}/bgmnull.c)
    add_compile_definitions(_NO_SOUND)
endif()

set(PLATFORM_SOURCES
    ${ENGINE_TOP}/hexen2/sys_web.c
    ${COMMONDIR}/in_web.c
    ${COMMONDIR}/midi_nul.c
    ${COMMONDIR}/cd_null.c
)
if(WEB_RENDERER STREQUAL "webgpu")
    list(APPEND PLATFORM_SOURCES ${COMMONDIR}/vid_webgpu.c)
else()
    list(APPEND PLATFORM_SOURCES
        ${COMMONDIR}/vid_soft_web.c
        ${COMMONDIR}/web_canvas_wgpu.c
    )
endif()
add_compile_definitions(_NO_MIDIDRV)

add_executable(uhexen2_web
    ${RENDERER_SOURCES}
    ${CLIENT_SOURCES}
    ${COMMON_SOURCES}
    ${SOUND_SOURCES}
    ${PLATFORM_SOURCES}
)

target_link_options(uhexen2_web PRIVATE
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=134217728
    -sSTACK_SIZE=2097152
    -sENVIRONMENT=web
    -sFORCE_FILESYSTEM=1
    -sINVOKE_RUN=0
    -sNO_EXIT_RUNTIME=1
    -sEXPORTED_FUNCTIONS=['_main','_Web_TouchKey','_Web_TouchLook','_Web_GyroLook','_Web_ResizeCanvas','_Web_FlushConfig']
    -sEXPORTED_RUNTIME_METHODS=['FS','callMain','ccall']
    --shell-file=${CMAKE_CURRENT_SOURCE_DIR}/web/shell.html
)

if(WEB_RENDERER STREQUAL "software")
    target_link_options(uhexen2_web PRIVATE
        --js-library=${CMAKE_CURRENT_SOURCE_DIR}/web/webgpu_present.js
    )
    set_property(TARGET uhexen2_web APPEND PROPERTY LINK_DEPENDS
        ${CMAKE_CURRENT_SOURCE_DIR}/web/webgpu_present.js
    )
endif()

if(WEB_RENDERER STREQUAL "webgpu")
    target_link_options(uhexen2_web PRIVATE
        --js-library=${CMAKE_CURRENT_SOURCE_DIR}/web/webgpu_nitro.js
    )
    set_property(TARGET uhexen2_web APPEND PROPERTY LINK_DEPENDS
        ${CMAKE_CURRENT_SOURCE_DIR}/web/webgpu_nitro.js
    )
endif()

if(USE_SOUND AND USE_CODEC_VORBIS)
    # The Emscripten vorbis port pulls in ogg automatically, but naming both
    # keeps the dependency explicit and lets `embuilder build ogg vorbis`
    # prefetch exactly what this build needs. The flags must appear on the
    # compile line too, not just the link line: that is what puts the port's
    # <vorbis/vorbisfile.h> and <ogg/ogg.h> on the include path.
    target_compile_options(uhexen2_web PRIVATE -sUSE_OGG=1 -sUSE_VORBIS=1)
    target_link_options(uhexen2_web PRIVATE -sUSE_OGG=1 -sUSE_VORBIS=1)
endif()

if(GAME_DATA_DIR)
    target_link_options(uhexen2_web PRIVATE --preload-file=${GAME_DATA_DIR}@/data1)
endif()

target_link_libraries(uhexen2_web PRIVATE m)
if(WEB_RENDERER STREQUAL "webgpu")
    set(WEB_OUTPUT_NAME hexenwail-nitro)
else()
    set(WEB_OUTPUT_NAME hexenwail)
endif()
set_target_properties(uhexen2_web PROPERTIES
    OUTPUT_NAME ${WEB_OUTPUT_NAME}
    SUFFIX ".html"
)
