| scenario | received | SSIM-Y | PSNR-Y | avg QP | limit | hint | change latency / fps | error |
|---|---|---|---|---|---|---|---|---|
| old-720_VP9_1200k | 480x270 | 0.8495 | 20.085176 | 33.7 | bandwidth | - | 256 ms / 26 fps |  |
| old-1080_VP9_1200k | 480x270 | 0.8776 | 21.181597 | 34.3 | bandwidth | - | 120 ms / 26 fps |  |
| new-exact_VP9_1200k | 1920x1080 | 0.9989 | 52.049515 | 102.8 | none | detail | 135 ms / 8 fps |  |
| new-page_VP9_1200k | 1920x1080 | 0.9841 | 28.102050 | 118.5 | none | detail | 141 ms / 10 fps |  |
