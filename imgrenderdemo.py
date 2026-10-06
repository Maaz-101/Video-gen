import glob
import math
import os
import numpy as np
from PIL import Image, ImageEnhance, ImageOps

# Universal MoviePy import (supports v1.x and v2.x)
try:
    from moviepy import (
        AudioFileClip,
        CompositeAudioClip,
        CompositeVideoClip,
        ImageClip,
        VideoClip,
        afx,
        concatenate_audioclips,
        concatenate_videoclips,
        vfx,
    )
    IS_V2 = True
except ImportError:
    from moviepy.editor import (
        AudioFileClip,
        CompositeAudioClip,
        CompositeVideoClip,
        ImageClip,
        VideoClip,
        afx,
        concatenate_audioclips,
        concatenate_videoclips,
        vfx,
    )
    IS_V2 = False

from natsort import natsorted

# Standard 1080p 16:9 Canvas
TARGET_WIDTH = 1920
TARGET_HEIGHT = 1080
OUTPUT_FPS = 24
SCENE_DURATION = 25.0


# --- SELECTIVE LIGHT SOURCE ENGINE ---


def extract_light_source_mask(frame_arr, threshold=0.62):
    """
    Extracts only the high-luminance regions (lightbulbs, window panes, lamps).
    Returns a smooth alpha mask targeting solely the light emitters.
    """
    # Perceptual luminance calculation
    luminance = (
        0.299 * frame_arr[:, :, 0]
        + 0.587 * frame_arr[:, :, 1]
        + 0.114 * frame_arr[:, :, 2]
    ) / 255.0

    # Soft transition above the threshold
    light_mask = np.clip((luminance - threshold) / (1.0 - threshold + 1e-5), 0.0, 1.0)
    # Smooth cubic falloff so natural glow edges blend seamlessly
    light_mask = light_mask**1.8
    return np.dstack([light_mask] * 3)


def get_bulb_flicker_multiplier(t):
    """
    Simulates erratic electrical voltage of a dying bulb or window light:
    - Subtle ambient electrical hum (high-frequency low-amplitude wave)
    - Random sharp dropouts (tube failure / dying filament)
    - Occasional surge flare
    """
    # 1. Base rapid electrical hum
    hum = 0.04 * math.sin(2 * math.pi * t * 14.0) + 0.02 * math.sin(2 * math.pi * t * 29.0)

    # 2. Pseudo-random dropouts using high-frequency sine beats (deterministic per timestamp)
    strobe_trigger = math.sin(t * 7.3) * math.cos(t * 19.7)
    drop = 0.0
    if strobe_trigger > 0.78:
        # Sudden voltage dip
        drop = -0.45 * (strobe_trigger - 0.78) / 0.22
    elif strobe_trigger < -0.85:
        # Sudden surge/flare
        drop = 0.35 * (-strobe_trigger - 0.85) / 0.15

    multiplier = 1.0 + hum + drop
    return np.clip(multiplier, 0.30, 1.45)


# --- ATMOSPHERIC POST-PROCESSING ---


def get_breathing_vignette(width, height, t, base_intensity=0.74):
    """Deep, slow-breathing corner vignette."""
    pulse = 0.05 * math.sin(2 * math.pi * t * 0.12)
    intensity = np.clip(base_intensity + pulse, 0.45, 0.95)

    x = np.linspace(-1, 1, width)
    y = np.linspace(-1, 1, height)
    xx, yy = np.meshgrid(x, y)
    radius = np.sqrt(xx**2 + yy**2)
    mask = 1.0 - np.clip((radius - 0.38) / 0.82, 0, 1) * intensity
    return np.dstack([mask] * 3)


def get_flashlight_sweep(width, height, t):
    """Handheld flashlight sweeping across the environment."""
    center_x = 0.50 + 0.22 * math.sin(2 * math.pi * t * 0.055)
    center_y = 0.52 + 0.14 * math.cos(2 * math.pi * t * 0.045)

    x = np.linspace(0, 1, width)
    y = np.linspace(0, 1, height)
    xx, yy = np.meshgrid(x, y)

    dist = np.sqrt(((xx - center_x) * (width / height)) ** 2 + (yy - center_y) ** 2)
    beam = np.clip(1.0 - (dist / 0.68), 0.0, 1.0) ** 2.2

    light_map = 0.46 + 0.54 * beam
    return np.dstack([light_map] * 3)


def get_floating_motes(width, height, t, num_particles=28):
    """Subtle dust motes drifting upward."""
    layer = np.zeros((height, width), dtype=np.float32)
    np.random.seed(1337)

    base_x = np.random.uniform(0.05, 0.95, num_particles)
    base_y = np.random.uniform(0.05, 0.95, num_particles)
    speeds = np.random.uniform(0.008, 0.020, num_particles)
    radii = np.random.randint(1, 3, num_particles)

    for i in range(num_particles):
        cur_y = int(((base_y[i] - t * speeds[i]) % 1.0) * height)
        cur_x = int((base_x[i] + 0.008 * math.sin(t * 0.6 + i)) * width) % width
        r = radii[i]
        y1, y2 = max(0, cur_y - r), min(height, cur_y + r)
        x1, x2 = max(0, cur_x - r), min(width, cur_x + r)
        layer[y1:y2, x1:x2] += 0.20

    return np.dstack([layer] * 3)


def apply_cinematic_horror_pass(frame, t):
    """
    Composites selective lightbulb/window flickering,
    ambient sweeps, and desaturated cold psychological grading.
    """
    h, w, _ = frame.shape
    arr = frame.astype(np.float32)

    # 1. SELECTIVE BULB & WINDOW FLICKER
    # Isolate only the luminous objects (filaments, lamps, glass reflections)
    light_mask = extract_light_source_mask(arr, threshold=0.60)
    bulb_power = get_bulb_flicker_multiplier(t)

    # Modulate ONLY the pixels under the light mask, leaving walls and dark rooms stable
    flickered_lights = arr * bulb_power
    arr = (arr * (1.0 - light_mask)) + (flickered_lights * light_mask)

    # 2. Desaturated Cold Psychological Grading
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    img = ImageEnhance.Color(img).enhance(0.42)
    img = ImageEnhance.Contrast(img).enhance(1.22)
    arr = np.array(img, dtype=np.float32)

    arr[:, :, 0] *= 0.88  # Depress Reds
    arr[:, :, 1] *= 0.96  # Muted Greens
    arr[:, :, 2] *= 1.06  # Cold Blues

    # 3. Handheld Flashlight Sweep
    arr *= get_flashlight_sweep(w, h, t)

    # 4. Floating Dust Motes
    dust = get_floating_motes(w, h, t) * 255.0
    arr = np.clip(arr + dust, 0, 255)

    # 5. Breathing Corner Vignette
    arr *= get_breathing_vignette(w, h, t)

    return np.clip(arr, 0, 255).astype(np.uint8)


# --- JITTER-FREE SUB-PIXEL CAMERA ENGINE ---


def create_smooth_25s_scene(image_path, duration=SCENE_DURATION, scene_idx=0):
    """
    Applies floating-point affine transformations with bicubic resampling.
    Zero pixel-snapping, zero micro-shake.
    """
    base_pil = Image.open(image_path).convert("RGB")
    base_pil = ImageOps.fit(
        base_pil, (TARGET_WIDTH, TARGET_HEIGHT), method=Image.Resampling.LANCZOS
    )

    pattern = scene_idx % 3
    if pattern == 0:
        pan_dir_x, pan_dir_y = 0.0, -0.02
        zoom_peak = 1.13
    elif pattern == 1:
        pan_dir_x, pan_dir_y = 0.035, 0.0
        zoom_peak = 1.10
    else:
        pan_dir_x, pan_dir_y = -0.02, 0.015
        zoom_peak = 0.94

    def frame_generator(t):
        p = t / duration

        # Smooth dual-phase progression
        if p < 0.60:
            eased_p = 0.40 * (p / 0.60) ** 1.2
        else:
            eased_p = 0.40 + 0.60 * ((p - 0.60) / 0.40) ** 1.3

        if zoom_peak >= 1.0:
            scale = 1.00 + (zoom_peak - 1.00) * eased_p
        else:
            scale = 1.06 - (1.06 - zoom_peak) * eased_p

        dx = (pan_dir_x * TARGET_WIDTH) * eased_p
        dy = (pan_dir_y * TARGET_HEIGHT) * eased_p

        cx = TARGET_WIDTH / 2.0
        cy = TARGET_HEIGHT / 2.0

        # Inverted affine transform mapping
        a = 1.0 / scale
        b = 0.0
        c = cx - (cx - dx) / scale
        d = 0.0
        e = 1.0 / scale
        f = cy - (cy - dy) / scale

        transformed = base_pil.transform(
            (TARGET_WIDTH, TARGET_HEIGHT),
            Image.Transform.AFFINE,
            (a, b, c, d, e, f),
            resample=Image.Resampling.BICUBIC,
        )

        frame_arr = np.array(transformed)
        return apply_cinematic_horror_pass(frame_arr, t)

    if IS_V2:
        return VideoClip(frame_function=frame_generator).with_duration(duration)
    else:
        return VideoClip(frame_generator, duration=duration)


# --- MAIN PIPELINE ---


def render_story_video(
    images, start_scene_num=1, voiceover_path=None, bgm_path=None, output_file=None
):
    if not images:
        print("Error: No images found in selected range.")
        return

    timeline_clips = []
    print(f"\nProcessing {len(images)} Scenes (Selective Bulb Flicker + 25s Creep)...")

    for i, img_path in enumerate(images):
        scene_idx = start_scene_num + i
        print(f" ├── [Scene {scene_idx:02d}] Generating scene: {os.path.basename(img_path)}...")
        clip = create_smooth_25s_scene(img_path, duration=SCENE_DURATION, scene_idx=i)
        timeline_clips.append(clip)

    print("\nConcatenating timeline clips...")
    final_video = concatenate_videoclips(timeline_clips, method="compose")
    total_duration = final_video.duration
    print(f"Total Visual Duration: {total_duration:.1f}s (~{total_duration/60:.2f} mins)")

    # --- AUDIO MIXING ---
    audio_tracks = []

    if voiceover_path and os.path.exists(voiceover_path):
        print(f"Mixing Voiceover: {os.path.basename(voiceover_path)}")
        if IS_V2:
            vo_clip = AudioFileClip(voiceover_path).with_volume_scaled(1.0)
            if vo_clip.duration > total_duration:
                vo_clip = vo_clip.subclipped(0, total_duration)
        else:
            vo_clip = AudioFileClip(voiceover_path).volumex(1.0)
            if vo_clip.duration > total_duration:
                vo_clip = vo_clip.subclip(0, total_duration)
        audio_tracks.append(vo_clip)

    if bgm_path and os.path.exists(bgm_path):
        print(f"Mixing Ambient Horror BGM (Bed level 11%): {os.path.basename(bgm_path)}")
        if IS_V2:
            bgm_raw = AudioFileClip(bgm_path)
            if bgm_raw.duration < total_duration:
                repeats = int(np.ceil(total_duration / bgm_raw.duration))
                bgm_raw = concatenate_audioclips([bgm_raw] * repeats)
            bgm = bgm_raw.subclipped(0, total_duration).with_volume_scaled(0.11)
        else:
            bgm_raw = AudioFileClip(bgm_path)
            if bgm_raw.duration < total_duration:
                repeats = int(np.ceil(total_duration / bgm_raw.duration))
                bgm_raw = concatenate_audioclips([bgm_raw] * repeats)
            bgm = bgm_raw.subclip(0, total_duration).volumex(0.11)
        audio_tracks.append(bgm)

    if audio_tracks:
        final_audio = CompositeAudioClip(audio_tracks)
        final_video = (
            final_video.with_audio(final_audio)
            if IS_V2
            else final_video.set_audio(final_audio)
        )

    print(f"\nRendering final storytelling video to: {output_file}")
    final_video.write_videofile(
        output_file,
        fps=OUTPUT_FPS,
        codec="libx264",
        audio_codec="aac",
        preset="fast",
        bitrate="7000k",
        threads=4,
    )
    print(f"\n[SUCCESS] Final Video Saved: {output_file}")


if __name__ == "__main__":
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

    IMAGES_DIR = os.path.join(BASE_DIR, "outputs")
    VOICEOVER_FILE = os.path.join(BASE_DIR, "full_story_narration.mp3")
    BGM_FILE = os.path.join(BASE_DIR, "ambient_horror.mp3")
    OUTPUT_PATH = os.path.join(BASE_DIR, "horror_story_selective_flicker_25s.mp4")

    all_images = natsorted(
        glob.glob(os.path.join(IMAGES_DIR, "*.png"))
        + glob.glob(os.path.join(IMAGES_DIR, "*.jpg"))
        + glob.glob(os.path.join(IMAGES_DIR, "*.jpeg"))
    )

    # Adjust your scene count here
    START_SCENE = 1
    END_SCENE = 2

    selected_images = all_images[START_SCENE - 1 : END_SCENE]
    print(f"Loaded {len(selected_images)} scene images from {IMAGES_DIR}.")

    render_story_video(
        selected_images,
        start_scene_num=START_SCENE,
        voiceover_path=VOICEOVER_FILE,
        bgm_path=BGM_FILE,
        output_file=OUTPUT_PATH,
    )