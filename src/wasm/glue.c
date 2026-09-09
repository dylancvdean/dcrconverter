#include "speex/speex.h"

#define MAX_FRAME 640
#define MAX_PACKET 256

static void *decoder;
static SpeexBits bits;
static spx_int16_t pcm[MAX_FRAME];
static unsigned char packet[MAX_PACKET];
static int frame_size;
static int bits_ready;

__attribute__((export_name("speex_open")))
int speex_open(int sample_rate) {
  const SpeexMode *mode;
  int enh = 1;

  if (decoder) {
    speex_decoder_destroy(decoder);
    decoder = 0;
    if (bits_ready) {
      speex_bits_destroy(&bits);
      bits_ready = 0;
    }
  }

  if (sample_rate <= 8000)
    mode = &speex_nb_mode;
  else if (sample_rate <= 16000)
    mode = &speex_wb_mode;
  else
    mode = &speex_uwb_mode;

  decoder = speex_decoder_init(mode);
  if (!decoder)
    return 0;
  speex_decoder_ctl(decoder, SPEEX_SET_ENH, &enh);
  speex_decoder_ctl(decoder, SPEEX_GET_FRAME_SIZE, &frame_size);
  speex_bits_init(&bits);
  bits_ready = 1;
  if (frame_size > MAX_FRAME)
    frame_size = MAX_FRAME;
  return frame_size;
}

__attribute__((export_name("speex_in_ptr")))
unsigned char *speex_in_ptr(void) {
  return packet;
}

__attribute__((export_name("speex_pcm_ptr")))
spx_int16_t *speex_pcm_ptr(void) {
  return pcm;
}

__attribute__((export_name("speex_frame_size")))
int speex_frame_size(void) {
  return frame_size;
}

__attribute__((export_name("speex_decode_frame")))
int speex_decode_frame(int len) {
  if (!decoder || len <= 0 || len > MAX_PACKET)
    return -2;
  speex_bits_read_from(&bits, (char *)packet, len);
  return speex_decode_int(decoder, &bits, pcm);
}

__attribute__((export_name("speex_close")))
void speex_close(void) {
  if (decoder) {
    speex_decoder_destroy(decoder);
    decoder = 0;
  }
  if (bits_ready) {
    speex_bits_destroy(&bits);
    bits_ready = 0;
  }
  frame_size = 0;
}
