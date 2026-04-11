"""
PyTorchRunner Python SDK — setup.py
"""
from setuptools import setup, find_packages

setup(
    name="pytorch-runner-sdk",
    version="1.0.0",
    description="Lightweight Python SDK for PyTorchRunner API integration",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="PyTorchRunner",
    python_requires=">=3.8",
    packages=find_packages(exclude=["tests*", "examples*"]),
    install_requires=[
        "requests>=2.28.0",
    ],
    extras_require={
        "async": ["aiohttp>=3.9.0"],
        "images": ["Pillow>=9.0.0"],
        "numpy": ["numpy>=1.24.0"],
        "all": ["aiohttp>=3.9.0", "Pillow>=9.0.0", "numpy>=1.24.0"],
        "dev": [
            "pytest>=7.0.0",
            "pytest-asyncio>=0.21.0",
            "responses>=0.25.0",
            "numpy>=1.24.0",
            "Pillow>=9.0.0",
        ],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
    ],
)
