@echo off
rem 啟動本機的 Ollama，並允許 ResearchFlow 網站連線（Windows）。先安裝 Ollama 並執行：ollama pull qwen3.5:9b
rem 如果工作列已經有 Ollama 在執行，請先結束它再執行這個檔案。
set OLLAMA_ORIGINS=https://researchflow-3dd2c.web.app,https://researchflow-3dd2c.firebaseapp.com,http://localhost:*,http://127.0.0.1:*
ollama serve
pause
