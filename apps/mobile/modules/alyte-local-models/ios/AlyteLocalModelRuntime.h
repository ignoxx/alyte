#ifndef ALYTE_LOCAL_MODEL_RUNTIME_H
#define ALYTE_LOCAL_MODEL_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

typedef enum AlyteLocalModelRuntimeFailureStage {
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_NONE = 0,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_MODEL_LOAD = 1,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_CONTEXT = 2,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_GRAMMAR = 3,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_SAMPLER = 4,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_ALLOCATION = 5,
} AlyteLocalModelRuntimeFailureStage;

// A deliberately narrow C ABI keeps the accepted llama.cpp runtime behind the Expo module.
// No model bytes, prompts, or generated output cross this boundary.
void *alyte_local_model_runtime_create(
    const char *model_path,
    const char *grammar,
    const char *grammar_root,
    int32_t *failure_stage_out);
void alyte_local_model_runtime_cancel(void *runtime);
int alyte_local_model_runtime_generate(
    void *runtime,
    const char *prompt,
    int max_output_tokens,
    char *output,
    size_t output_capacity);
void alyte_local_model_runtime_destroy(void *runtime);

#endif
