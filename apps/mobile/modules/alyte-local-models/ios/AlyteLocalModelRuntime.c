#include "AlyteLocalModelRuntime.h"

#include <stdlib.h>

#if defined(ALYTE_LLAMA_RUNTIME)
#include <llama.h>

struct AlyteLocalModelRuntime {
    struct llama_model *model;
    struct llama_context *context;
};

static void alyte_local_model_discard_log(enum ggml_log_level level, const char *text, void *user_data) {
    (void) level;
    (void) text;
    (void) user_data;
}

void *alyte_local_model_runtime_create(const char *model_path) {
    if (model_path == NULL) {
        return NULL;
    }

    llama_log_set(alyte_local_model_discard_log, NULL);
    llama_backend_init();

    struct llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = -1;
    model_params.load_mode = LLAMA_LOAD_MODE_MMAP;
    struct llama_model *model = llama_model_load_from_file(model_path, model_params);
    if (model == NULL) {
        return NULL;
    }

    // A small context proves that the exact runtime can activate the verified model. #52 owns
    // prompt/schema configuration and creates the narrow inference session it needs later.
    struct llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = 512;
    context_params.n_batch = 512;
    context_params.n_ubatch = 512;
    context_params.n_seq_max = 1;
    context_params.n_threads = 2;
    context_params.n_threads_batch = 2;
    context_params.n_outputs_max = 1;
    context_params.no_perf = true;
    struct llama_context *context = llama_init_from_model(model, context_params);
    if (context == NULL) {
        llama_model_free(model);
        return NULL;
    }

    struct AlyteLocalModelRuntime *runtime =
        (struct AlyteLocalModelRuntime *) calloc(1, sizeof(struct AlyteLocalModelRuntime));
    if (runtime == NULL) {
        llama_free(context);
        llama_model_free(model);
        return NULL;
    }
    runtime->model = model;
    runtime->context = context;
    return runtime;
}

void alyte_local_model_runtime_destroy(void *opaque_runtime) {
    struct AlyteLocalModelRuntime *runtime = (struct AlyteLocalModelRuntime *) opaque_runtime;
    if (runtime == NULL) {
        return;
    }
    llama_free(runtime->context);
    llama_model_free(runtime->model);
    free(runtime);
}

#else

void *alyte_local_model_runtime_create(const char *model_path) {
    (void) model_path;
    return NULL;
}

void alyte_local_model_runtime_destroy(void *runtime) {
    (void) runtime;
}

#endif
