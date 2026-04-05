#!/usr/bin/env python3
"""Test script for live streaming - outputs lines with delays"""
import time
import sys

print("=== Streaming Test Start ===", flush=True)
for i in range(5):
    print(f"Step {i+1}/5: processing...", flush=True)
    time.sleep(0.3)
print("=== Streaming Test Complete ===", flush=True)
