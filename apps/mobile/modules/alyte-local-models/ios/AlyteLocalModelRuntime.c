#include "AlyteLocalModelRuntime.h"
#include "AlyteLocalModelRuntimeActivation.h"

#include <stdlib.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE
#include <os/proc.h>
#endif
#endif

uint64_t alyte_local_model_runtime_available_memory(void) {
#if defined(__APPLE__) && TARGET_OS_IPHONE
    return (uint64_t) os_proc_available_memory();
#else
    // The simulator/fake runtime does not own production model memory. Native production code
    // supplies the iOS value above; returning an unconstrained value keeps the transport/core
    // harness platform-independent without weakening the device admission gate.
    return UINT64_MAX;
#endif
}

#if defined(ALYTE_LLAMA_RUNTIME)
#include <llama.h>

#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <os/log.h>

enum {
    ALYTE_LOCAL_MODEL_STATUS_INVALID_ARGUMENT = -1,
    ALYTE_LOCAL_MODEL_STATUS_OUTPUT_LIMIT = -2,
    ALYTE_LOCAL_MODEL_STATUS_INPUT_LIMIT = -3,
    ALYTE_LOCAL_MODEL_STATUS_TOKENIZATION_FAILED = -4,
    ALYTE_LOCAL_MODEL_STATUS_PROMPT_DECODE_FAILED = -5,
    ALYTE_LOCAL_MODEL_STATUS_TOKEN_DECODE_FAILED = -6,
    ALYTE_LOCAL_MODEL_STATUS_CANCELLED = -7,
};

// GPU activation can create Metal allocations before llama.cpp reports a context failure. Keep
// a conservative amount of live headroom so iOS can fall back to CPU before that allocation
// becomes a Jetsam event. The Swift admission gate still enforces the manifest's minimum.
static const uint64_t ALYTE_LOCAL_MODEL_MIN_GPU_HEADROOM_BYTES = 5ULL * 1000ULL * 1000ULL * 1000ULL;
static const int32_t ALYTE_LOCAL_MODEL_GPU_LAYER_LIMIT = 16;

struct AlyteLocalModelRuntime {
    struct llama_model *model;
    struct llama_context *context;
    const struct llama_vocab *vocab;
    struct llama_sampler *sampler_chain;
    int context_tokens;
    int batch_tokens;
    atomic_bool cancel_requested;
};

static void alyte_local_model_discard_log(enum ggml_log_level level, const char *text, void *user_data) {
    (void) level;
    (void) text;
    (void) user_data;
}

static const char *alyte_local_model_backend_label(AlyteLocalModelBackendMode backend_mode) {
    switch (backend_mode) {
        case ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED:
            return "gpu-preferred";
        case ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY:
            return "cpu-only";
        default:
            return NULL;
    }
}

static const char *alyte_local_model_attempt_stage_label(
    AlyteLocalModelActivationAttemptStage stage) {
    switch (stage) {
        case ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_MODEL_LOAD:
            return "model-load";
        case ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT:
            return "context";
        default:
            return NULL;
    }
}

static const char *alyte_local_model_batch_label(uint32_t batch_tokens) {
    switch (batch_tokens) {
        case ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_NONE:
            return "none";
        case ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_FULL:
            return "256";
        case ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_REDUCED:
            return "128";
        case ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_LOW:
            return "64";
        case ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_MINIMUM:
            return "32";
        default:
            return NULL;
    }
}

static void alyte_local_model_record_activation_attempt(
    AlyteLocalModelActivationAttemptStage stage,
    AlyteLocalModelBackendMode backend_mode,
    uint32_t batch_tokens) {
    const char *stage_label = alyte_local_model_attempt_stage_label(stage);
    const char *backend_label = alyte_local_model_backend_label(backend_mode);
    const char *batch_label = alyte_local_model_batch_label(batch_tokens);
    if (stage_label == NULL || backend_label == NULL || batch_label == NULL) return;
    if (stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_MODEL_LOAD &&
        batch_tokens != ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_NONE) return;
    if (stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT &&
        batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_NONE) return;
    if (stage != ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_MODEL_LOAD &&
        stage != ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT) return;

    static os_log_t activation_log;
    if (activation_log == NULL) {
        activation_log = os_log_create("com.alyte.local-models", "activation");
    }
    if (activation_log == NULL) return;
    os_log_error(
        activation_log,
        "Local model activation attempt stage=%{public}s backend=%{public}s batch=%{public}s",
        stage_label,
        backend_label,
        batch_label);
}

static struct llama_model *alyte_local_model_load(
    const char *model_path,
    AlyteLocalModelBackendMode backend_mode) {
    struct llama_model_params model_params = llama_model_default_params();
#if defined(ALYTE_LOCAL_MODEL_CPU_ONLY)
    model_params.n_gpu_layers = 0;
#else
    model_params.n_gpu_layers = backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY
        ? 0
        : ALYTE_LOCAL_MODEL_GPU_LAYER_LIMIT;
#endif
    model_params.load_mode = LLAMA_LOAD_MODE_MMAP;
    if (backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY) {
        // A NULL device list means "all available devices" in llama.cpp. That is not a CPU
        // fallback: on a device with an unavailable Metal queue the context can still fail
        // before it reaches the CPU backend. Restrict the retry explicitly to CPU.
        ggml_backend_dev_t cpu_device = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
        if (cpu_device == NULL) return NULL;
        ggml_backend_dev_t cpu_devices[] = { cpu_device, NULL };
        model_params.devices = cpu_devices;
        return llama_model_load_from_file(model_path, model_params);
    }
    return llama_model_load_from_file(model_path, model_params);
}

static struct llama_context_params alyte_local_model_context_params(
    uint32_t batch_tokens) {
    struct llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = 2048;
    context_params.n_batch = batch_tokens;
    context_params.n_ubatch = batch_tokens;
    context_params.n_seq_max = 1;
    context_params.n_threads = 4;
    context_params.n_threads_batch = 4;
    context_params.n_outputs_max = 1;
    context_params.no_perf = true;
    return context_params;
}

static void *alyte_local_model_load_with_mode(
    const char *model_path,
    AlyteLocalModelBackendMode backend_mode) {
    return alyte_local_model_load(model_path, backend_mode);
}

static void *alyte_local_model_create_context_with_batch(
    void *opaque_model,
    uint32_t batch_tokens) {
    struct llama_context_params context_params = alyte_local_model_context_params(batch_tokens);
    return llama_init_from_model((struct llama_model *) opaque_model, context_params);
}

static void alyte_local_model_free_model(void *opaque_model) {
    llama_model_free((struct llama_model *) opaque_model);
}

static void alyte_local_model_set_failure_stage(
    int32_t *failure_stage_out,
    AlyteLocalModelRuntimeFailureStage failure_stage) {
    if (failure_stage_out != NULL) *failure_stage_out = (int32_t) failure_stage;
}

static int alyte_local_model_tokenize(
    const struct llama_vocab *vocab,
    const char *text,
    llama_token **tokens_out) {
    size_t text_length = strlen(text);
    if (text_length > INT32_MAX) return ALYTE_LOCAL_MODEL_STATUS_TOKENIZATION_FAILED;
    int32_t probe = llama_tokenize(vocab, text, (int32_t) text_length, NULL, 0, false, true);
    if (probe == INT32_MIN) return ALYTE_LOCAL_MODEL_STATUS_TOKENIZATION_FAILED;
    int32_t required = probe < 0 ? -probe : probe;
    if (required <= 0 || (size_t) required > SIZE_MAX / sizeof(llama_token))
        return ALYTE_LOCAL_MODEL_STATUS_TOKENIZATION_FAILED;
    llama_token *tokens = (llama_token *) malloc(sizeof(llama_token) * (size_t) required);
    if (tokens == NULL) return ALYTE_LOCAL_MODEL_STATUS_TOKENIZATION_FAILED;
    int32_t count = llama_tokenize(vocab, text, (int32_t) text_length, tokens, required, false, true);
    if (count <= 0 || count > required) {
        free(tokens);
        return ALYTE_LOCAL_MODEL_STATUS_TOKENIZATION_FAILED;
    }
    *tokens_out = tokens;
    return count;
}

void *alyte_local_model_runtime_create(
    const char *model_path,
    const char *grammar,
    const char *grammar_root,
    int32_t *failure_stage_out) {
    alyte_local_model_set_failure_stage(
        failure_stage_out,
        ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_NONE);
    if (model_path == NULL || grammar == NULL || grammar_root == NULL) return NULL;
    llama_log_set(alyte_local_model_discard_log, NULL);
    llama_backend_init();
    AlyteLocalModelActivationHooks hooks = {
        .load_model = alyte_local_model_load_with_mode,
        .create_context = alyte_local_model_create_context_with_batch,
        .free_model = alyte_local_model_free_model,
        .record_attempt = alyte_local_model_record_activation_attempt,
    };
    AlyteLocalModelActivation activation;
    AlyteLocalModelBackendMode preferred_backend_mode = ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED;
#if defined(ALYTE_LOCAL_MODEL_CPU_ONLY)
    preferred_backend_mode = ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY;
#else
    // Select the backend before activation. GPU-first fallback is too late when Metal's initial
    // mapping itself crosses the process's current iOS memory budget.
    if (alyte_local_model_runtime_available_memory() < ALYTE_LOCAL_MODEL_MIN_GPU_HEADROOM_BYTES) {
        preferred_backend_mode = ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY;
    }
#endif
    if (!alyte_local_model_activate_with_preferred_backend(
            model_path,
            preferred_backend_mode,
            &hooks,
            &activation)) {
        alyte_local_model_set_failure_stage(
            failure_stage_out,
            activation.failure_stage == ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_CONTEXT
                ? ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_CONTEXT
                : ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_MODEL_LOAD);
        return NULL;
    }
    struct llama_model *model = (struct llama_model *) activation.model;
    struct llama_context *context = (struct llama_context *) activation.context;
    uint32_t batch_tokens = activation.batch_tokens;
    const struct llama_vocab *vocab = llama_model_get_vocab(model);
    if (vocab == NULL) {
        llama_free(context);
        llama_model_free(model);
        alyte_local_model_set_failure_stage(
            failure_stage_out,
            ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_GRAMMAR);
        return NULL;
    }
    struct llama_sampler *grammar_sampler = llama_sampler_init_grammar(vocab, grammar, grammar_root);
    if (grammar_sampler == NULL) {
        llama_free(context);
        llama_model_free(model);
        alyte_local_model_set_failure_stage(
            failure_stage_out,
            ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_GRAMMAR);
        return NULL;
    }
    struct llama_sampler_chain_params chain_params = llama_sampler_chain_default_params();
    chain_params.no_perf = true;
    struct llama_sampler *sampler_chain = llama_sampler_chain_init(chain_params);
    if (sampler_chain == NULL) {
        llama_sampler_free(grammar_sampler);
        llama_free(context);
        llama_model_free(model);
        alyte_local_model_set_failure_stage(
            failure_stage_out,
            ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_SAMPLER);
        return NULL;
    }
    llama_sampler_chain_add(sampler_chain, grammar_sampler);
    struct llama_sampler *greedy_sampler = llama_sampler_init_greedy();
    if (greedy_sampler == NULL) {
        llama_sampler_free(sampler_chain);
        llama_free(context);
        llama_model_free(model);
        alyte_local_model_set_failure_stage(
            failure_stage_out,
            ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_SAMPLER);
        return NULL;
    }
    llama_sampler_chain_add(sampler_chain, greedy_sampler);
    struct AlyteLocalModelRuntime *runtime = (struct AlyteLocalModelRuntime *) calloc(1, sizeof(*runtime));
    if (runtime == NULL) {
        llama_sampler_free(sampler_chain);
        llama_free(context);
        llama_model_free(model);
        alyte_local_model_set_failure_stage(
            failure_stage_out,
            ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_ALLOCATION);
        return NULL;
    }
    runtime->model = model;
    runtime->context = context;
    runtime->vocab = vocab;
    runtime->sampler_chain = sampler_chain;
    runtime->context_tokens = 2048;
    runtime->batch_tokens = (int) batch_tokens;
    atomic_init(&runtime->cancel_requested, false);
    return runtime;
}

void alyte_local_model_runtime_cancel(void *opaque_runtime) {
    struct AlyteLocalModelRuntime *runtime = (struct AlyteLocalModelRuntime *) opaque_runtime;
    if (runtime != NULL) atomic_store_explicit(&runtime->cancel_requested, true, memory_order_release);
}

int alyte_local_model_runtime_generate(
    void *opaque_runtime,
    const char *prompt,
    int max_output_tokens,
    char *output,
    size_t output_capacity) {
    struct AlyteLocalModelRuntime *runtime = (struct AlyteLocalModelRuntime *) opaque_runtime;
    if (runtime == NULL || prompt == NULL || output == NULL || output_capacity == 0 || max_output_tokens <= 0)
        return ALYTE_LOCAL_MODEL_STATUS_INVALID_ARGUMENT;
    // Consume a pressure/timeout signal that arrived while this request was waiting on the
    // serialized store queue. Do not clear it blindly: that would let a queued generation start
    // after the OS had already asked us to stop.
    if (atomic_exchange_explicit(&runtime->cancel_requested, false, memory_order_acq_rel)) {
        return ALYTE_LOCAL_MODEL_STATUS_CANCELLED;
    }
    output[0] = '\0';
    llama_memory_clear(llama_get_memory(runtime->context), true);
    llama_sampler_reset(runtime->sampler_chain);
    llama_token *prompt_tokens = NULL;
    int prompt_count = alyte_local_model_tokenize(runtime->vocab, prompt, &prompt_tokens);
    if (prompt_count <= 0) return prompt_count;
    if (prompt_count + max_output_tokens >= runtime->context_tokens) {
        free(prompt_tokens);
        return ALYTE_LOCAL_MODEL_STATUS_INPUT_LIMIT;
    }
    for (int offset = 0; offset < prompt_count;) {
        if (atomic_load_explicit(&runtime->cancel_requested, memory_order_acquire)) {
            free(prompt_tokens);
            atomic_store_explicit(&runtime->cancel_requested, false, memory_order_release);
            return ALYTE_LOCAL_MODEL_STATUS_CANCELLED;
        }
        int count = prompt_count - offset;
        if (count > runtime->batch_tokens) count = runtime->batch_tokens;
        struct llama_batch batch = llama_batch_get_one(prompt_tokens + offset, count);
        if (llama_decode(runtime->context, batch) != 0) {
            free(prompt_tokens);
            return ALYTE_LOCAL_MODEL_STATUS_PROMPT_DECODE_FAILED;
        }
        offset += count;
    }
    size_t output_length = 0;
    for (int index = 0; index < max_output_tokens; index += 1) {
        if (atomic_load_explicit(&runtime->cancel_requested, memory_order_acquire)) {
            free(prompt_tokens);
            output[0] = '\0';
            atomic_store_explicit(&runtime->cancel_requested, false, memory_order_release);
            return ALYTE_LOCAL_MODEL_STATUS_CANCELLED;
        }
        llama_token token = llama_sampler_sample(runtime->sampler_chain, runtime->context, -1);
        if (token < 0) {
            free(prompt_tokens);
            output[0] = '\0';
            return ALYTE_LOCAL_MODEL_STATUS_TOKEN_DECODE_FAILED;
        }
        if (llama_vocab_is_eog(runtime->vocab, token)) break;
        char piece[256];
        int32_t piece_length = llama_token_to_piece(runtime->vocab, token, piece, (int32_t) sizeof(piece), 0, false);
        if (piece_length < 0 || output_length + (size_t) piece_length + 1 > output_capacity) {
            free(prompt_tokens);
            output[0] = '\0';
            return ALYTE_LOCAL_MODEL_STATUS_OUTPUT_LIMIT;
        }
        memcpy(output + output_length, piece, (size_t) piece_length);
        output_length += (size_t) piece_length;
        output[output_length] = '\0';
        struct llama_batch next = llama_batch_get_one(&token, 1);
        if (llama_decode(runtime->context, next) != 0) {
            free(prompt_tokens);
            output[0] = '\0';
            return ALYTE_LOCAL_MODEL_STATUS_TOKEN_DECODE_FAILED;
        }
    }
    free(prompt_tokens);
    atomic_store_explicit(&runtime->cancel_requested, false, memory_order_release);
    return (int) output_length;
}

void alyte_local_model_runtime_destroy(void *opaque_runtime) {
    struct AlyteLocalModelRuntime *runtime = (struct AlyteLocalModelRuntime *) opaque_runtime;
    if (runtime == NULL) return;
    llama_sampler_free(runtime->sampler_chain);
    llama_free(runtime->context);
    llama_model_free(runtime->model);
    free(runtime);
}

#else

void *alyte_local_model_runtime_create(
    const char *model_path,
    const char *grammar,
    const char *grammar_root,
    int32_t *failure_stage_out) {
    (void) model_path;
    (void) grammar;
    (void) grammar_root;
    if (failure_stage_out != NULL) {
        *failure_stage_out = ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_NONE;
    }
    return NULL;
}

int alyte_local_model_runtime_generate(
    void *runtime,
    const char *prompt,
    int max_output_tokens,
    char *output,
    size_t output_capacity) {
    (void) runtime;
    (void) prompt;
    (void) max_output_tokens;
    if (output != NULL && output_capacity > 0) output[0] = '\0';
    return -1;
}

void alyte_local_model_runtime_cancel(void *runtime) {
    (void) runtime;
}

void alyte_local_model_runtime_destroy(void *runtime) {
    (void) runtime;
}

#endif
