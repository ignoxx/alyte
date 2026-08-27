#include "AlyteLocalModelRuntimeActivation.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct SyntheticModel {
    AlyteLocalModelBackendMode mode;
} SyntheticModel;

typedef struct SyntheticContext {
    uint32_t batch_tokens;
} SyntheticContext;

typedef struct SyntheticAttempt {
    AlyteLocalModelActivationAttemptStage stage;
    AlyteLocalModelBackendMode backend_mode;
    uint32_t batch_tokens;
} SyntheticAttempt;

static SyntheticModel gpu_model = { ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED };
static SyntheticModel cpu_model = { ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY };
static SyntheticContext cpu_context = { 32 };
static AlyteLocalModelBackendMode load_modes[2];
static uint32_t context_batches[8];
static SyntheticAttempt activation_attempts[10];
static void *freed_models[2];
static size_t load_count;
static size_t context_count;
static size_t attempt_count;
static size_t free_count;

static void *load_model(const char *model_path, AlyteLocalModelBackendMode mode) {
    assert(strcmp(model_path, "synthetic") == 0);
    load_modes[load_count++] = mode;
    return mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY ? &cpu_model : &gpu_model;
}

static void *create_context(void *model, uint32_t batch_tokens) {
    context_batches[context_count++] = batch_tokens;
    if (model == &cpu_model && batch_tokens == cpu_context.batch_tokens) return &cpu_context;
    return NULL;
}

static void free_model(void *model) { freed_models[free_count++] = model; }

static void record_attempt(
    AlyteLocalModelActivationAttemptStage stage,
    AlyteLocalModelBackendMode backend_mode,
    uint32_t batch_tokens) {
    activation_attempts[attempt_count++] = (SyntheticAttempt) {
        stage,
        backend_mode,
        batch_tokens,
    };
}

static const AlyteLocalModelActivationHooks hooks = {
    .load_model = load_model,
    .create_context = create_context,
    .free_model = free_model,
    .record_attempt = record_attempt,
};

int main(void) {
    AlyteLocalModelActivation activation;
    assert(alyte_local_model_activate_with_fallback("synthetic", &hooks, &activation));
    assert(activation.failure_stage == ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_NONE);
    assert(activation.backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(activation.batch_tokens == 32);
    assert(load_count == 2);
    assert(load_modes[0] == ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED);
    assert(load_modes[1] == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(context_count == 8);
    assert(context_batches[0] == 256);
    assert(context_batches[1] == 128);
    assert(context_batches[2] == 64);
    assert(context_batches[3] == 32);
    assert(context_batches[4] == 256);
    assert(context_batches[5] == 128);
    assert(context_batches[6] == 64);
    assert(context_batches[7] == 32);
    assert(attempt_count == 10);
    assert(activation_attempts[0].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_MODEL_LOAD);
    assert(activation_attempts[0].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED);
    assert(activation_attempts[0].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_NONE);
    assert(activation_attempts[1].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[1].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED);
    assert(activation_attempts[1].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_FULL);
    assert(activation_attempts[2].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[2].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED);
    assert(activation_attempts[2].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_REDUCED);
    assert(activation_attempts[3].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[3].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED);
    assert(activation_attempts[3].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_LOW);
    assert(activation_attempts[4].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[4].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED);
    assert(activation_attempts[4].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_MINIMUM);
    assert(activation_attempts[5].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_MODEL_LOAD);
    assert(activation_attempts[5].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(activation_attempts[5].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_NONE);
    assert(activation_attempts[6].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[6].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(activation_attempts[6].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_FULL);
    assert(activation_attempts[7].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[7].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(activation_attempts[7].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_REDUCED);
    assert(activation_attempts[8].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[8].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(activation_attempts[8].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_LOW);
    assert(activation_attempts[9].stage == ALYTE_LOCAL_MODEL_ACTIVATION_ATTEMPT_CONTEXT);
    assert(activation_attempts[9].backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(activation_attempts[9].batch_tokens == ALYTE_LOCAL_MODEL_ACTIVATION_BATCH_MINIMUM);
    assert(free_count == 1);
    assert(freed_models[0] == &gpu_model);

    // The successful CPU pair is owned by the caller after the helper returns.
    free_model(activation.model);
    assert(free_count == 2);
    assert(freed_models[1] == &cpu_model);

    // Production selects this mode before activation when current headroom is below the Metal
    // threshold. The helper must not probe GPU first in that case.
    load_count = 0;
    context_count = 0;
    attempt_count = 0;
    free_count = 0;
    assert(alyte_local_model_activate_with_preferred_backend(
        "synthetic",
        ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY,
        &hooks,
        &activation));
    assert(activation.backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(activation.batch_tokens == 32);
    assert(load_count == 1);
    assert(load_modes[0] == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    assert(context_count == 4);
    assert(attempt_count == 5);
    free_model(activation.model);
    assert(free_count == 1);
    assert(freed_models[0] == &cpu_model);
    return 0;
}
