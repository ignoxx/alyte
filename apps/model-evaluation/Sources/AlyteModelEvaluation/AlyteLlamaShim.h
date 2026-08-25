#ifndef ALYTE_LLAMA_SHIM_H
#define ALYTE_LLAMA_SHIM_H

#include <stdbool.h>
#include <stddef.h>

typedef struct AlyteLlamaSession AlyteLlamaSession;

/*
 * This is the only C surface consumed by the evaluation target. The model path, grammar and
 * generated text stay in process memory; callers are responsible for retaining aggregate metrics
 * only. The implementation is compiled only when the externally staged llama.xcframework is
 * supplied to the Xcode target.
 */
void *alyte_llama_session_create(
    const char *model_path,
    const char *grammar,
    const char *grammar_root,
    int context_tokens,
    int batch_tokens,
    int threads);

int alyte_llama_session_generate(
    void *session,
    const char *prompt,
    int max_output_tokens,
    char *output,
    size_t output_capacity);

void alyte_llama_session_destroy(void *session);

#endif
