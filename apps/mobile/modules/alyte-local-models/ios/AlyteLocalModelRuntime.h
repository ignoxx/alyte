#ifndef ALYTE_LOCAL_MODEL_RUNTIME_H
#define ALYTE_LOCAL_MODEL_RUNTIME_H

#include <stddef.h>

// A deliberately narrow C ABI keeps the accepted llama.cpp runtime behind the Expo module.
// No model bytes, prompts, or generated output cross this boundary.
void *alyte_local_model_runtime_create(
    const char *model_path,
    const char *grammar,
    const char *grammar_root);
void alyte_local_model_runtime_cancel(void *runtime);
int alyte_local_model_runtime_generate(
    void *runtime,
    const char *prompt,
    int max_output_tokens,
    char *output,
    size_t output_capacity);
void alyte_local_model_runtime_destroy(void *runtime);

#endif
