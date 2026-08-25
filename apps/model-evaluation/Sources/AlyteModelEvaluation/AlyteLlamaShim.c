#include "AlyteLlamaShim.h"

#include <stdlib.h>

#if defined(ALYTE_LLAMA_EVAL)
#include <llama.h>

#include <limits.h>
#include <stdint.h>
#include <string.h>

enum {
    ALYTE_LLAMA_STATUS_INVALID_ARGUMENT = -1,
    ALYTE_LLAMA_STATUS_OUTPUT_LIMIT = -2,
    ALYTE_LLAMA_STATUS_INPUT_LIMIT = -3,
    ALYTE_LLAMA_STATUS_TOKENIZATION_FAILED = -4,
    ALYTE_LLAMA_STATUS_PROMPT_DECODE_FAILED = -5,
    ALYTE_LLAMA_STATUS_TOKEN_DECODE_FAILED = -6,
};

struct AlyteLlamaSession {
    struct llama_model *model;
    struct llama_context *context;
    const struct llama_vocab *vocab;
    struct llama_sampler *sampler_chain;
    int context_tokens;
    int batch_tokens;
};

static void alyte_llama_discard_log(enum ggml_log_level level, const char *text, void *user_data) {
    (void) level;
    (void) text;
    (void) user_data;
}

static int alyte_llama_tokenize(
    const struct llama_vocab *vocab,
    const char *text,
    llama_token **tokens_out) {
    size_t text_length = strlen(text);
    if (text_length > INT32_MAX) {
        return -1;
    }

    int32_t required_probe = llama_tokenize(
        vocab,
        text,
        (int32_t) text_length,
        NULL,
        0,
        false,
        true);
    // llama.cpp reports the required capacity as a negative count when the supplied buffer is
    // too small. The null/zero-capacity sizing probe intentionally takes that path.
    if (required_probe == INT32_MIN) {
        return ALYTE_LLAMA_STATUS_TOKENIZATION_FAILED;
    }
    int32_t required = required_probe < 0 ? -required_probe : required_probe;
    if (required <= 0 || (size_t) required > SIZE_MAX / sizeof(llama_token)) {
        return ALYTE_LLAMA_STATUS_TOKENIZATION_FAILED;
    }

    llama_token *tokens = (llama_token *) malloc(sizeof(llama_token) * (size_t) required);
    if (tokens == NULL) {
        return ALYTE_LLAMA_STATUS_TOKENIZATION_FAILED;
    }

    int32_t count = llama_tokenize(
        vocab,
        text,
        (int32_t) text_length,
        tokens,
        required,
        false,
        true);
    if (count <= 0 || count > required) {
        free(tokens);
        return ALYTE_LLAMA_STATUS_TOKENIZATION_FAILED;
    }

    *tokens_out = tokens;
    return count;
}

void *alyte_llama_session_create(
    const char *model_path,
    const char *grammar,
    const char *grammar_root,
    int context_tokens,
    int batch_tokens,
    int threads) {
    if (model_path == NULL || grammar == NULL || grammar_root == NULL ||
        context_tokens <= 0 || batch_tokens <= 0 || threads <= 0) {
        return NULL;
    }

    llama_log_set(alyte_llama_discard_log, NULL);
    llama_backend_init();

    struct llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = -1;
    model_params.load_mode = LLAMA_LOAD_MODE_MMAP;
    struct llama_model *model = llama_model_load_from_file(model_path, model_params);
    if (model == NULL) {
        return NULL;
    }

    struct llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = (uint32_t) context_tokens;
    context_params.n_batch = (uint32_t) batch_tokens;
    context_params.n_ubatch = (uint32_t) batch_tokens;
    context_params.n_seq_max = 1;
    context_params.n_threads = threads;
    context_params.n_threads_batch = threads;
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

    AlyteLlamaSession *session = (AlyteLlamaSession *) calloc(1, sizeof(AlyteLlamaSession));
    if (session == NULL) {
        llama_sampler_free(sampler_chain);
        llama_free(context);
        llama_model_free(model);
        return NULL;
    }
    session->model = model;
    session->context = context;
    session->vocab = vocab;
    session->sampler_chain = sampler_chain;
    session->context_tokens = context_tokens;
    session->batch_tokens = batch_tokens;
    return (void *) session;
}

int alyte_llama_session_generate(
    void *opaque_session,
    const char *prompt,
    int max_output_tokens,
    char *output,
    size_t output_capacity) {
    AlyteLlamaSession *session = (AlyteLlamaSession *) opaque_session;
    if (session == NULL || prompt == NULL || output == NULL || output_capacity == 0 ||
        max_output_tokens <= 0) {
        return ALYTE_LLAMA_STATUS_INVALID_ARGUMENT;
    }
    output[0] = '\0';

    llama_memory_clear(llama_get_memory(session->context), true);
    llama_sampler_reset(session->sampler_chain);

    llama_token *prompt_tokens = NULL;
    int prompt_count = alyte_llama_tokenize(session->vocab, prompt, &prompt_tokens);
    if (prompt_count <= 0) {
        return prompt_count == ALYTE_LLAMA_STATUS_TOKENIZATION_FAILED
            ? ALYTE_LLAMA_STATUS_TOKENIZATION_FAILED
            : ALYTE_LLAMA_STATUS_INVALID_ARGUMENT;
    }
    if (prompt_count + max_output_tokens >= session->context_tokens) {
        free(prompt_tokens);
        return ALYTE_LLAMA_STATUS_INPUT_LIMIT;
    }

    // n_batch is the logical maximum accepted by llama_decode. Prefill in bounded chunks so a
    // valid prompt below the context limit cannot fail merely because it exceeds that batch size.
    for (int offset = 0; offset < prompt_count; ) {
        int chunk_count = prompt_count - offset;
        if (chunk_count > session->batch_tokens) {
            chunk_count = session->batch_tokens;
        }
        struct llama_batch prompt_batch = llama_batch_get_one(prompt_tokens + offset, chunk_count);
        if (llama_decode(session->context, prompt_batch) != 0) {
            free(prompt_tokens);
            return ALYTE_LLAMA_STATUS_PROMPT_DECODE_FAILED;
        }
        offset += chunk_count;
    }

    size_t output_length = 0;
    for (int index = 0; index < max_output_tokens; index += 1) {
        llama_token token = llama_sampler_sample(session->sampler_chain, session->context, -1);
        if (token < 0) {
            free(prompt_tokens);
            output[0] = '\0';
            return ALYTE_LLAMA_STATUS_TOKEN_DECODE_FAILED;
        }
        if (llama_vocab_is_eog(session->vocab, token)) {
            break;
        }

        char piece[256];
        int32_t piece_length = llama_token_to_piece(session->vocab, token, piece, (int32_t) sizeof(piece), 0, false);
        if (piece_length < 0 || output_length + (size_t) piece_length + 1 > output_capacity) {
            free(prompt_tokens);
            output[0] = '\0';
            return ALYTE_LLAMA_STATUS_OUTPUT_LIMIT;
        }
        memcpy(output + output_length, piece, (size_t) piece_length);
        output_length += (size_t) piece_length;
        output[output_length] = '\0';

        struct llama_batch next_batch = llama_batch_get_one(&token, 1);
        if (llama_decode(session->context, next_batch) != 0) {
            free(prompt_tokens);
            output[0] = '\0';
            return ALYTE_LLAMA_STATUS_TOKEN_DECODE_FAILED;
        }
    }

    free(prompt_tokens);
    return (int) output_length;
}

void alyte_llama_session_destroy(void *opaque_session) {
    AlyteLlamaSession *session = (AlyteLlamaSession *) opaque_session;
    if (session == NULL) {
        return;
    }
    llama_sampler_free(session->sampler_chain);
    llama_free(session->context);
    llama_model_free(session->model);
    free(session);
}

#else

struct AlyteLlamaSession {
    int unavailable;
};

void *alyte_llama_session_create(
    const char *model_path,
    const char *grammar,
    const char *grammar_root,
    int context_tokens,
    int batch_tokens,
    int threads) {
    (void) model_path;
    (void) grammar;
    (void) grammar_root;
    (void) context_tokens;
    (void) batch_tokens;
    (void) threads;
    return NULL;
}

int alyte_llama_session_generate(
    void *session,
    const char *prompt,
    int max_output_tokens,
    char *output,
    size_t output_capacity) {
    (void) session;
    (void) prompt;
    (void) max_output_tokens;
    if (output != NULL && output_capacity > 0) {
        output[0] = '\0';
    }
    return -1;
}

void alyte_llama_session_destroy(void *session) {
    free(session);
}

#endif
