#include "AlyteLocalModelRuntimeActivation.h"

#include <stddef.h>

enum {
    ALYTE_LOCAL_MODEL_FULL_BATCH_TOKENS = 256,
    ALYTE_LOCAL_MODEL_REDUCED_BATCH_TOKENS = 128,
};

static bool alyte_local_model_create_context(
    void *model,
    const AlyteLocalModelActivationHooks *hooks,
    void **context_out,
    uint32_t *batch_tokens_out) {
    const uint32_t attempts[] = {
        ALYTE_LOCAL_MODEL_FULL_BATCH_TOKENS,
        ALYTE_LOCAL_MODEL_REDUCED_BATCH_TOKENS,
    };
    for (size_t index = 0; index < sizeof(attempts) / sizeof(attempts[0]); index += 1) {
        void *context = hooks->create_context(model, attempts[index]);
        if (context != NULL) {
            *context_out = context;
            *batch_tokens_out = attempts[index];
            return true;
        }
    }
    return false;
}

bool alyte_local_model_activate_with_fallback(
    const char *model_path,
    const AlyteLocalModelActivationHooks *hooks,
    AlyteLocalModelActivation *activation) {
    if (model_path == NULL || hooks == NULL || activation == NULL || hooks->load_model == NULL ||
        hooks->create_context == NULL || hooks->free_model == NULL) {
        return false;
    }

    activation->model = NULL;
    activation->context = NULL;
    activation->batch_tokens = 0;
    activation->backend_mode = ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED;
    activation->failure_stage = ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_NONE;

    void *model = hooks->load_model(model_path, ALYTE_LOCAL_MODEL_BACKEND_GPU_PREFERRED);
    if (model == NULL) {
        activation->backend_mode = ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY;
        model = hooks->load_model(model_path, ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
    }
    if (model == NULL) {
        activation->failure_stage = ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_MODEL_LOAD;
        return false;
    }

    void *context = NULL;
    uint32_t batch_tokens = 0;
    if (!alyte_local_model_create_context(model, hooks, &context, &batch_tokens)) {
        hooks->free_model(model);
        if (activation->backend_mode == ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY) {
            activation->failure_stage = ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_CONTEXT;
            return false;
        }
        activation->backend_mode = ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY;
        model = hooks->load_model(model_path, ALYTE_LOCAL_MODEL_BACKEND_CPU_ONLY);
        if (model == NULL) {
            activation->failure_stage = ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_MODEL_LOAD;
            return false;
        }
        if (!alyte_local_model_create_context(model, hooks, &context, &batch_tokens)) {
            hooks->free_model(model);
            activation->failure_stage = ALYTE_LOCAL_MODEL_ACTIVATION_FAILURE_CONTEXT;
            return false;
        }
    }

    activation->model = model;
    activation->context = context;
    activation->batch_tokens = batch_tokens;
    return true;
}
