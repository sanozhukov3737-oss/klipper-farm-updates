// App-owned pipe worker; the pinned Whisper model is loaded once per process.
// Headers and DLLs are both whisper.cpp v1.8.4. No TCP listener or audio files.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include "whisper.h"
#include "whisper-context.h"

static bool read_exact(void * target, size_t size) {
    return std::fread(target, 1, size, stdin) == size;
}
static void frame(const std::string & text, bool error = false) {
    uint32_t size = static_cast<uint32_t>(text.size()) | (error ? 0x80000000u : 0);
    if (std::fwrite(&size, 1, 4, stdout) != 4 ||
        std::fwrite(text.data(), 1, text.size(), stdout) != text.size() || std::fflush(stdout)) {
        throw std::runtime_error("Speech output pipe closed");
    }
}
template<class T> T symbol(HMODULE library, const char * name) {
    const auto value = GetProcAddress(library, name);
    if (!value) throw std::runtime_error("Pinned Whisper DLL export missing");
    return reinterpret_cast<T>(value);
}
int main(int argc, char ** argv) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    whisper_context * context = nullptr;
    decltype(&whisper_free) release = nullptr;
    try {
        const char * model_name = argc == 2 ? argv[1] : "ggml-base-q5_1.bin";
        if (argc > 2 || (std::strcmp(model_name, "ggml-base-q5_1.bin") != 0 &&
                         std::strcmp(model_name, "ggml-small-q5_1.bin") != 0)) {
            throw std::runtime_error("Unsupported packaged Whisper model");
        }
        // The working directory is the app's speech/whisper resource folder.
        // Relative ASCII model/DLL names also work under Cyrillic parent paths.
        wchar_t dll_path[32768];
        auto path_size = GetFullPathNameW(L"whisper.dll", 32768, dll_path, nullptr);
        if (!path_size || path_size >= 32768) throw std::runtime_error("Cannot resolve packaged Whisper DLL");
        auto library = LoadLibraryExW(dll_path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
        if (!library) throw std::runtime_error("Cannot load packaged Whisper DLL");
        auto backend = GetModuleHandleW(L"ggml.dll");
        if (!backend) throw std::runtime_error("Cannot locate packaged GGML backend");
        symbol<decltype(&ggml_backend_load_all)>(backend, "ggml_backend_load_all")();
        auto defaults = symbol<decltype(&whisper_context_default_params)>(library, "whisper_context_default_params");
        auto init = symbol<decltype(&whisper_init_from_file_with_params)>(library, "whisper_init_from_file_with_params");
        release = symbol<decltype(&whisper_free)>(library, "whisper_free");
        auto parameters = symbol<decltype(&whisper_full_default_params)>(library, "whisper_full_default_params");
        auto recognize = symbol<decltype(&whisper_full)>(library, "whisper_full");
        auto segments = symbol<decltype(&whisper_full_n_segments)>(library, "whisper_full_n_segments");
        auto segment_text = symbol<decltype(&whisper_full_get_segment_text)>(library, "whisper_full_get_segment_text");
        // Уверенность распознавания: произведение вероятностей токенов показывает,
        // насколько модель уверена в услышанном. Без неё тихую или шумную запись
        // нельзя отличить от чёткой, и программа выполняет неверную команду.
        auto token_count = symbol<decltype(&whisper_full_n_tokens)>(library, "whisper_full_n_tokens");
        auto token_p = symbol<decltype(&whisper_full_get_token_p)>(library, "whisper_full_get_token_p");
        auto config = defaults(); config.use_gpu = false;
        context = init(model_name, config);
        if (!context) throw std::runtime_error("Cannot load packaged Whisper model");
        frame(""); // Ready, after loading the model. No microphone has been opened.
        while (true) {
            uint32_t size = 0;
            if (!read_exact(&size, 4)) break;
            if (size < farm_speech::min_wave_bytes || size > farm_speech::max_request_bytes) throw std::runtime_error("Invalid speech frame size");
            std::vector<unsigned char> payload(size);
            if (!read_exact(payload.data(), size)) break;
            const auto request = farm_speech::parse_recognition_frame(payload);
            const auto wave = payload.data() + request.wave_offset;
            std::vector<float> samples((size - request.wave_offset - 44) / 2);
            for (size_t i = 0; i < samples.size(); ++i) {
                int16_t value; std::memcpy(&value, wave+44+i*2, 2);
                samples[i] = value / 32768.0f;
            }
            auto params = parameters(WHISPER_SAMPLING_GREEDY);
            const auto hardware_threads = std::thread::hardware_concurrency();
            params.n_threads = static_cast<int>(std::min(4u, hardware_threads > 1 ? hardware_threads - 1 : 1u));
            params.language = "ru";
            params.no_context = true;
            params.no_timestamps = true;
            params.single_segment = true;
            params.print_special = params.print_progress = params.print_realtime = params.print_timestamps = false;
            params.greedy.best_of = 1;
            params.temperature_inc = 0.0f;
            // The string lives through this synchronous decode only. A fresh
            // params object plus no_context prevents vocabulary leaking to the
            // next recording, including a following legacy raw-WAV request.
            params.initial_prompt = request.context.empty() ? nullptr : request.context.c_str();
            params.carry_initial_prompt = false;
            if (recognize(context, params, samples.data(), static_cast<int>(samples.size())) != 0) {
                frame("Whisper could not recognize this recording", true); continue;
            }
            std::string text;
            double log_sum = 0.0; int scored = 0;
            for (int i = 0; i < segments(context); ++i) {
                const char * part = segment_text(context, i);
                if (part) text += part;
                const int count = token_count(context, i);
                for (int t = 0; t < count; ++t) {
                    const float p = token_p(context, i, t);
                    // Токены с нулевой вероятностью пропускаем: они не несут смысла.
                    if (!(p > 0.0f)) continue;
                    log_sum += std::log(static_cast<double>(p > 1.0f ? 1.0f : p));
                    ++scored;
                }
            }
            const double confidence = scored > 0 ? std::exp(log_sum / scored) : 0.0;
            // Формат ответа: уверенность, табуляция, текст. Старый формат без
            // префикса остаётся допустимым для совместимости со старым клиентом.
            if (text.size() > 8192) frame("Recognition result exceeded its limit", true);
            else {
                char prefix[32];
                std::snprintf(prefix, sizeof(prefix), "%.4f\t", confidence);
                frame(std::string(prefix) + text);
            }
        }
        release(context); return 0;
    } catch (const std::exception & error) {
        if (context && release) release(context);
        try { frame(error.what(), true); } catch (...) {}
        return 1;
    }
}
