import torch
import gc

print(f"CUDA 可用: {torch.cuda.is_available()}")
print(f"CUDA 版本: {torch.version.cuda}")
print(f"GPU 数量: {torch.cuda.device_count()}")

if torch.cuda.is_available():
    for i in range(torch.cuda.device_count()):
        print(f"GPU {i}: {torch.cuda.get_device_name(i)}")

torch.cuda.empty_cache()
gc.collect()
print(f"GPU 显存总计：{torch.cuda.get_device_properties(0).total_memory / 1024 ** 3:.2f} GB")
print(f"可用显存：{torch.cuda.mem_get_info()[0] / 1024 ** 3:.2f} GB")

