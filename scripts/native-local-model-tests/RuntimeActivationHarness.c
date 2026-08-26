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

static SyntheticModel gpu_model = { ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED };
static SyntheticModel cpu_model = { ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY };
static SyntheticContext cpu_context = { 32 };
static AlyteLocalModelBackendMode load_modes[2];
static uint32_t context_batches[8];
static void *freed_models[2];
static size_t load_count;
static size_t context_count;
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

static const AlyteLocalModelActivationHooks hooks = {
    .load_model = load_model,
    .create_context = create_context,
    .free_model = free_model,
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
    assert(free_count == 1);
    assert(freed_models[0] == &gpu_model);

    // The successful CPU pair is owned by the caller after the helper returns.
    free_model(activation.model);
    assert(free_count == 2);
    assert(freed_models[1] == &cpu_model);
    return 0;
}
