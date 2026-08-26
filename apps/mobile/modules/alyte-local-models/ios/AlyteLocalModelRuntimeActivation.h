#ifndef ALYTE_LOCAL_MODEL_RUNTIME_ACTIVATION_H
#define ALYTE_LOCAL_MODEL_RUNTIME_ACTIVATION_H

#include <stdbool.h>
#include <stdint.h>

// The first attempt keeps the evaluated GPU path. CPU-only is an explicit fallback so a
// successful model load cannot accidentally initialize every available backend again.
typedef enum AlyteLocalModelBackendMode {
    ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED = 0,
    ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY = 1,
} AlyteLocalModelBackendMode;

typedef enum AlyteLocalModelActivationAttemptStage {
    ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_MODEL_LOAD = 1,
    ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT = 2,
} AlyteLocalModelActivationAttemptStage;

typedef enum AlyteLocalModelActivationBatchTokens {
    ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_NONE = 0,
    ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_FULL = 256,
    ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_REDUCED = 128,
    ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_LOW = 64,
    ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_MINIMUM = 32,
} AlyteLocalModelActivationBatchTokens;

typedef enum AlyteLocalModelActivationFailureStage {
    ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_NONE = 0,
    ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_MODEL_LOAD = 1,
    ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_CONTEXT = 2,
} AlyteLocalModelActivationFailureStage;

typedef struct AlyteLocalModelActivationHooks {
    void *(*load_model)(const char *model_path, AlyteLocalModelBackendMode mode);
    void *(*create_context)(void *model, uint32_t batch_tokens);
    void (*free_model)(void *model);
    // Optional privacy-safe marker invoked immediately before model/context allocation.
    // Model-load attempts use ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_NONE.
    void (*record_attempt)(
        AlyteLocalModelActivationAttemptStage stage,
        AlyteLocalModelBackendMode backend_mode,
        uint32_t batch_tokens);
} AlyteLocalModelActivationHooks;

typedef struct AlyteLocalModelActivation {
    void *model;
    void *context;
    uint32_t batch_tokens;
    AlyteLocalModelBackendMode backend_mode;
    AlyteLocalModelActivationFailureStage failure_stage;
} AlyteLocalModelActivation;

// Returns an owned model/context pair. On failure, every model acquired by this function is
// released through free_model; on success, ownership transfers to the caller.
bool alyte_local_model_activate_with_fallback(
    const char *model_path,
    const AlyteLocalModelActivationHooks *hooks,
    AlyteLocalModelActivation *activation);

#endif
