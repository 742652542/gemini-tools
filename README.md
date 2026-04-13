# gemini-tools [![Build Status](https://travis-ci.org/arq5x/gemini.png?branch=master)](https://travis-ci.org/arq5x/gemini)

## server.py 依赖安装

`server.py` 使用到的第三方 Python 依赖如下：

- `fastapi`
- `uvicorn`（建议安装 `uvicorn[standard]`）
- `pydantic`
- `httpx`
- `boto3`（会自动包含 `botocore`）

安装命令：

```bash
pip install "uvicorn[standard]" fastapi pydantic httpx boto3
```

## 运行前额外要求

- 需要可执行程序 `GeminiWatermarkTool`（`server.py` 中通过 `subprocess` 调用）
- 需要项目根目录下存在 `config.json`，并包含 `s3` 配置（`access_key_id`、`secret_access_key`、`endpoint_url`、`bucket_name`）
