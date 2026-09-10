#ifndef ALYTE_LOCAL_MODEL_RUNTIME_H
#define ALYTE_LOCAL_MODEL_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

// Advisory current headroom supplied by iOS. A caller must sample this immediately before
// activation; it is deliberately not persisted or included in diagnostics.
uint64_t alyte_local_model_runtime_available_memory(void);

typedef enum AlyteLocalModelRuntimeFailureStage {
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_NONE = 0,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_MODEL_LOAD = 1,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_CONTEXT = 2,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_GRAMMAR = 3,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_SAMPLER = 4,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_ALLOCATION = 5,
    ALYTE_LOCAL_MODEL_RUNTIME_FAILURE_PROJECTOR = 6,
} AlyteLocalModelRuntimeFailureStage;

// A deliberately narrow C ABI keeps the accepted llama.cpp runtime behind the Expo module.
// No model bytes, prompts, or generated output cross this boundary.
void *alyte_local_model_runtime_create(
    const char *model_path,
    const char *projector_path,
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
int alyte_local_model_runtime_generate_image(
    void *runtime,
    const char *prompt,
    const unsigned char *image_data,
    size_t image_length,
    int max_output_tokens,
    char *output,
    size_t output_capacity);
int alyte_local_model_runtime_generate_image_raw(
    void *runtime,
    const char *prompt,
    const unsigned char *image_data,
    size_t image_length,
    int max_output_tokens,
    char *output,
    size_t output_capacity);
void alyte_local_model_runtime_destroy(void *runtime);

#endif
