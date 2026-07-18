#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <vector>

namespace {
int g_width = 0;
int g_height = 0;
bool g_initialized = false;
std::vector<float> g_gray;
std::vector<float> g_blurred;
std::vector<float> g_previous;
std::vector<float> g_accumulator;

void ensure_size(int width, int height) {
  if (width == g_width && height == g_height) return;
  g_width = width;
  g_height = height;
  const auto size = static_cast<std::size_t>(width * height);
  g_gray.assign(size, 0.0f);
  g_blurred.assign(size, 0.0f);
  g_previous.assign(size, 0.0f);
  g_accumulator.assign(size, 0.0f);
  g_initialized = false;
}
}

extern "C" {

std::uint8_t* alloc(int bytes) {
  return static_cast<std::uint8_t*>(std::malloc(static_cast<std::size_t>(bytes)));
}

void release(std::uint8_t* pointer) {
  std::free(pointer);
}

void reset_processor() {
  std::fill(g_previous.begin(), g_previous.end(), 0.0f);
  std::fill(g_accumulator.begin(), g_accumulator.end(), 0.0f);
  g_initialized = false;
}

void process_frame(
  const std::uint8_t* input,
  std::uint8_t* output,
  int width,
  int height,
  float threshold,
  float decay,
  float gain
) {
  ensure_size(width, height);
  const int size = width * height;

  for (int i = 0, p = 0; i < size; ++i, p += 4) {
    g_gray[i] = 0.299f * input[p] + 0.587f * input[p + 1] + 0.114f * input[p + 2];
  }

  for (int y = 0; y < height; ++y) {
    const int y0 = std::max(0, y - 1);
    const int y1 = std::min(height - 1, y + 1);
    for (int x = 0; x < width; ++x) {
      const int x0 = std::max(0, x - 1);
      const int x1 = std::min(width - 1, x + 1);
      float sum = 0.0f;
      int count = 0;
      for (int yy = y0; yy <= y1; ++yy) {
        for (int xx = x0; xx <= x1; ++xx) {
          sum += g_gray[yy * width + xx];
          ++count;
        }
      }
      g_blurred[y * width + x] = sum / static_cast<float>(count);
    }
  }

  if (!g_initialized) {
    g_previous = g_blurred;
    g_initialized = true;
  }

  for (int i = 0, p = 0; i < size; ++i, p += 4) {
    float diff = std::fabs(g_blurred[i] - g_previous[i]);
    if (diff < threshold) diff = 0.0f;
    diff *= gain;
    g_accumulator[i] = std::min(255.0f, std::max(g_accumulator[i] * decay, diff));
    const auto value = static_cast<std::uint8_t>(g_accumulator[i]);
    output[p] = value;
    output[p + 1] = value;
    output[p + 2] = value;
    output[p + 3] = 255;
  }
  g_previous = g_blurred;
}

}
