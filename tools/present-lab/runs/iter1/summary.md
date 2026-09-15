| scenario | received | SSIM-Y | PSNR-Y | avg QP | limit | hint | change latency / fps | error |
|---|---|---|---|---|---|---|---|---|
| old-720_VP9_1200k | 480x270 | 0.8494 | 20.085098 | 30.9 | bandwidth | - | 155 ms / 26 fps |  |
| old-1080_VP9_1200k | 480x270 | 0.8778 | 21.187301 | 33.7 | bandwidth | - | 90 ms / 28 fps |  |
| new-exact_VP9_1200k | 1920x1080 | 0.9989 | 51.941102 | 124.5 | none | detail | 392 ms / 7 fps |  |
| new-page_VP9_1200k | 1920x1080 | 0.9841 | 28.110162 | 129.8 | none | detail | 159 ms / 7 fps |  |
