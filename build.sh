#!/bin/sh
# Opcional e só no macOS: compila o helper nativo (OCR Vision), que deixa o QA ~2x mais rápido e mais preciso.
# Em Windows e Linux não é preciso compilar nada: o backend portátil (JS + tesseract.js) é usado automaticamente.
cd "$(dirname "$0")" || exit 1
if [ "$(uname)" != "Darwin" ]; then echo "helper nativo é só para macOS; nada a compilar neste sistema"; exit 0; fi
swiftc -O -swift-version 5 fxctl.swift -o fxctl && echo "fxctl compilado"
