#include "AlyteLocalModelRuntime.h"

#include <stdlib.h>
#include <stdatomic.h>
#include <stdbool.h>

#if defined(ALYTE_LLAMA_RUNTIME)
#include <llama.h>

#include <limits.h>
#include <stdint.h>
#include <string.h>

enum {
    ALYTE_LOCAL_MODEL_STATUS_INVALID_ARGUMENT = -1,
    ALYTE_LOCAL_MODEL_STATUS_OUTPUT_LIMIT = -2,
    ALYTE_LOCAL_MODEL_STATUS_INPUT_LIMIT = -3,
    ALYTE_LOCAL_MODEL_STATUS_TOKENIZATION_FAILED = -4,
    ALYTE_LOCAL_MODEL_STATUS_PROMPT_DECODE_FAILED = -5,
    ALYTE_LOCAL_MODEL_STATUS_TOKEN_DECODE_FAILED = -6,
    ALYTE_LOCAL_MODEL_STATUS_CANCELLED = -7,
};

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
    const char *grammar_root) {
    if (model_path == NULL || grammar == NULL || grammar_root == NULL) return NULL;
    llama_log_set(alyte_local_model_discard_log, NULL);
    llama_backend_init();
    struct llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = -1;
    model_params.load_mode = LLAMA_LOAD_MODE_MMAP;
    struct llama_model *model = llama_model_load_from_file(model_path, model_params);
    if (model == NULL) return NULL;
    struct llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = 2_048;
    context_params.n_batch = 256;
    context_params.n_ubatch = 256;
    context_params.n_seq_max = 1;
    context_params.n_threads = 4;
    context_params.n_threads_batch = 4;
    context_params.n_outputs_max = 1;
    context_params.no_perf = true;
    struct llama_context *context = llama_init_from_model(model, context_params);
    if (context == NULL) {
        llama_model_free(model);
        return NULL;
    }
    const struct llama_vocab *vocab = llama_model_get_vocab(model);
    struct llama_sampler *grammar_sampler = llama_sampler_init_grammar(vocab, grammar, grammar_root);
    if (grammar_sampler == NULL) {
        llama_free(context);
        llama_model_free(model);
        return NULL;
    }
    struct llama_sampler_chain_params chain_params = llama_sampler_chain_default_params();
    chain_params.no_perf = true;
    struct llama_sampler *sampler_chain = llama_sampler_chain_init(chain_params);
    if (sampler_chain == NULL) {
        llama_sampler_free(grammar_sampler);
        llama_free(context);
        llama_model_free(model);
        return NULL;
    }
    llama_sampler_chain_add(sampler_chain, grammar_sampler);
    llama_sampler_chain_add(sampler_chain, llama_sampler_init_greedy());
    struct AlyteLocalModelRuntime *runtime = (struct AlyteLocalModelRuntime *) calloc(1, sizeof(*runtime));
    if (runtime == NULL) {
        llama_sampler_free(sampler_chain);
        llama_free(context);
        llama_model_free(model);
        return NULL;
    }
    runtime->model = model;
    runtime->context = context;
    runtime->vocab = vocab;
    runtime->sampler_chain = sampler_chain;
    runtime->context_tokens = 2_048;
    runtime->batch_tokens = 256;
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
    const char *grammar_root) {
    (void) model_path;
    (void) grammar;
    (void) grammar_root;
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
