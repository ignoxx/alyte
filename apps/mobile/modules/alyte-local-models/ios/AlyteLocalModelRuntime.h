#ifndef ALYTE_LOCAL_MODEL_RUNTIME_H
#define ALYTE_LOCAL_MODEL_RUNTIME_H

// A deliberately narrow C ABI keeps the accepted llama.cpp runtime behind the Expo module.
// No model bytes, prompts, or generated output cross this boundary.
void *alyte_local_model_runtime_create(const char *model_path);
void alyte_local_model_runtime_destroy(void *runtime);

#endif
