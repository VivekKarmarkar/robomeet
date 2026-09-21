| scenario | received | SSIM-Y | PSNR-Y | avg QP | limit | hint | change latency / fps | error |
|---|---|---|---|---|---|---|---|---|
| old-720_VP9_1200k | 640x360 | 0.8546 | 20.237541 | 34.7 | bandwidth | - | 172 ms / 27 fps |  |
| old-1080_VP9_1200k | 320x180 | 0.851 | 20.298067 | 28 | bandwidth | - | 153 ms / 25 fps |  |
| new-exact_VP9_1200k | 1920x1080 | 0.9982 | 50.721491 | 154.1 | none | detail | 123 ms / 10 fps |  |
| new-page_VP9_1200k | 1920x1080 | 0.9816 | 28.066706 | 174 | none | detail | 140 ms / 9 fps |  |
