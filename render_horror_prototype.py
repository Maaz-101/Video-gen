import os
import re
import numpy as np
from PIL import Image, ImageEnhance, ImageOps
from natsort import natsorted

# Import MoviePy with version compatibility (supports v1.x and v2.x)
try:
    from moviepy import (
        CompositeVideoClip,
        ImageClip,
        VideoFileClip,
        concatenate_videoclips,
        vfx,
    )
    IS_V2 = True
except ImportError:
    from moviepy.editor import (
        CompositeVideoClip,
        ImageClip,
        VideoFileClip,
        concatenate_videoclips,
        vfx,
    )
    IS_V2 = False

# Standard 1080p 16:9 Canvas
TARGET_WIDTH = 1920
TARGET_HEIGHT = 1080
FPS = 24

# Exact Timing Breakdown per Scene
IMAGE_DURATION = 7.0               # 7s image
MAIN_VIDEO_DURATION = 15.0         # 15s main video
UNRECOGNIZABLE_EXT_DURATION = 7.0  # 7s extension (Total = 29s per scene)


# --- ATMOSPHERE POST-PROCESSING ---


def create_vignette_mask(width, height, intensity=0.70):
    """Generates a radial dark vignette mask."""
    x = np.linspace(-1, 1, width)
    y = np.linspace(-1, 1, height)
    xx, yy = np.meshgrid(x, y)
    radius = np.sqrt(xx**2 + yy**2)
    mask = 1.0 - np.clip((radius - 0.45) / 0.8, 0, 1) * intensity
    return np.dstack([mask] * 3)


VIGNETTE_MASK = create_vignette_mask(TARGET_WIDTH, TARGET_HEIGHT)


def apply_horror_grade(frame):
    """Applies high-contrast, desaturated cold horror grading + subtle film grain."""
    img = Image.fromarray(frame)

    enhancer = ImageEnhance.Color(img)
    img = enhancer.enhance(0.45)

    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.18)

    arr = np.array(img, dtype=np.float32)

    # Cold psychological tint
    arr[:, :, 0] *= 0.90  # Lower Reds
    arr[:, :, 1] *= 0.96  # Neutral Greens
    arr[:, :, 2] *= 1.04  # Slight Blue push

    # Apply Vignette
    arr = arr * VIGNETTE_MASK

    # Film Grain / Micro-texture
    noise = np.random.normal(0, 1.8, arr.shape)
    arr = arr + noise

    # Eerie micro-flicker
    flicker = np.random.uniform(0.98, 1.01)
    return np.clip(arr * flicker, 0, 255).astype(np.uint8)


# --- SCENE PROCESSORS ---


def process_image_scene(
    image_path, duration=IMAGE_DURATION, zoom_start=1.14, zoom_end=1.0
):
    """Loads an image, fits to 1080p, and zooms out to 1.0 for a seamless cut."""
    pil_img = Image.open(image_path).convert("RGB")
    pil_img = ImageOps.fit(
        pil_img, (TARGET_WIDTH, TARGET_HEIGHT), method=Image.Resampling.LANCZOS
    )
    temp_arr = np.array(pil_img)

    if IS_V2:
        base_clip = ImageClip(temp_arr).with_duration(duration)
        zoomed = base_clip.resized(
            lambda t: zoom_start + (zoom_end - zoom_start) * (t / duration)
        )
        return (
            CompositeVideoClip(
                [zoomed.with_position("center")],
                size=(TARGET_WIDTH, TARGET_HEIGHT),
            )
            .with_duration(duration)
            .image_transform(apply_horror_grade)
        )
    else:
        base_clip = ImageClip(temp_arr).set_duration(duration)
        zoomed = base_clip.resize(
            lambda t: zoom_start + (zoom_end - zoom_start) * (t / duration)
        )
        return (
            CompositeVideoClip(
                [zoomed.set_position("center")],
                size=(TARGET_WIDTH, TARGET_HEIGHT),
            )
            .set_duration(duration)
            .fl_image(apply_horror_grade)
        )


def process_22s_video_scene(video_path):
    """Builds a 22s total video: 15s main video + 7s extension."""
    raw_clip = VideoFileClip(video_path).without_audio()

    # 1. Canvas formatting
    if IS_V2:
        clip = raw_clip.resized(height=TARGET_HEIGHT)
        if clip.w < TARGET_WIDTH:
            clip = clip.resized(width=TARGET_WIDTH)
        centered = CompositeVideoClip(
            [clip.with_position("center")], size=(TARGET_WIDTH, TARGET_HEIGHT)
        )
    else:
        clip = raw_clip.resize(height=TARGET_HEIGHT)
        if clip.w < TARGET_WIDTH:
            clip = clip.resize(width=TARGET_WIDTH)
        centered = CompositeVideoClip(
            [clip.set_position("center")], size=(TARGET_WIDTH, TARGET_HEIGHT)
        )

    # 2. Main 15s Clip
    if centered.duration < MAIN_VIDEO_DURATION:
        loop_factor = int(np.ceil(MAIN_VIDEO_DURATION / max(centered.duration, 1))) + 1
        if IS_V2:
            reversed_clip = centered.with_effects([vfx.TimeMirror()])
            looped = concatenate_videoclips([centered, reversed_clip] * loop_factor)
            main_15s = looped.subclipped(0, MAIN_VIDEO_DURATION).image_transform(apply_horror_grade)
        else:
            reversed_clip = centered.fx(vfx.time_mirror)
            looped = concatenate_videoclips([centered, reversed_clip] * loop_factor)
            main_15s = looped.subclip(0, MAIN_VIDEO_DURATION).fl_image(apply_horror_grade)
    else:
        main_15s = (
            centered.subclipped(0, MAIN_VIDEO_DURATION).image_transform(apply_horror_grade)
            if IS_V2
            else centered.subclip(0, MAIN_VIDEO_DURATION).fl_image(apply_horror_grade)
        )

    # 3. 7s Extension
    if IS_V2:
        ext_source = centered.with_effects([vfx.TimeMirror(), vfx.MirrorX()])
        ext_source = ext_source.with_effects([vfx.MultiplySpeed(0.55)])
        ext_factor = int(np.ceil(UNRECOGNIZABLE_EXT_DURATION / max(ext_source.duration, 1))) + 1
        ext_looped = concatenate_videoclips([ext_source] * ext_factor)
        extension_7s = ext_looped.subclipped(0, UNRECOGNIZABLE_EXT_DURATION).image_transform(apply_horror_grade)
    else:
        ext_source = centered.fx(vfx.time_mirror).fx(vfx.mirror_x)
        ext_source = ext_source.fx(vfx.speedx, 0.55)
        ext_factor = int(np.ceil(UNRECOGNIZABLE_EXT_DURATION / max(ext_source.duration, 1))) + 1
        ext_looped = concatenate_videoclips([ext_source] * ext_factor)
        extension_7s = ext_looped.subclip(0, UNRECOGNIZABLE_EXT_DURATION).fl_image(apply_horror_grade)

    return concatenate_videoclips([main_15s, extension_7s], method="compose")


# --- MAIN PIPELINE ---


def render_story_video(images, videos, start_scene_num=60, output_file=None):
    scene_count = min(len(images), len(videos))
    if scene_count == 0:
        print("❌ Error: No matching images and videos found in the selected range.")
        return

    timeline_clips = []
    print(f"\n=======================================================")
    print(f"Constructing Timeline for {scene_count} Scenes")
    print(f"Target Duration: ~{scene_count * 29}s (~{(scene_count * 29)/60:.1f} mins)")
    print(f"=======================================================")

    for i in range(scene_count):
        current_scene_idx = start_scene_num + i
        print(f"[{i+1}/{scene_count}] Staging Scene {current_scene_idx:02d} -> {os.path.basename(images[i])} & {os.path.basename(videos[i])}")

        # 1. Image (7s) — Constant Zoom Out (1.14x down to 1.0x)
        img_clip = process_image_scene(
            images[i], duration=IMAGE_DURATION, zoom_start=1.14, zoom_end=1.0
        )
        timeline_clips.append(img_clip)

        # 2. Video (15s Main + 7s Ext = 22s)
        vid_clip = process_22s_video_scene(videos[i])
        timeline_clips.append(vid_clip)

    final_video = concatenate_videoclips(timeline_clips, method="compose")
    total_duration = final_video.duration
    print(f"\nTotal Visual Duration: {total_duration:.1f}s (~{total_duration/60:.2f} mins)")

    print(f"\nRendering final silent video to: {output_file}")
    final_video.write_videofile(
        output_file,
        fps=FPS,
        codec="libx264",
        audio=False,
        preset="medium",
        bitrate="8000k",
        threads=4,
    )
    print(f"\n[SUCCESS] Final Story Video saved: {output_file}")


if __name__ == "__main__":
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

    IMAGES_DIR = os.path.join(BASE_DIR, "outputs")
    VIDEOS_DIR = os.path.join(BASE_DIR, "outputs_video")
    OUTPUT_PATH = os.path.join(BASE_DIR, "horror_story_visual_only.mp4")

    # Safety check for directories
    if not os.path.exists(IMAGES_DIR):
        IMAGES_DIR = os.path.abspath("outputs")
    if not os.path.exists(VIDEOS_DIR):
        VIDEOS_DIR = os.path.abspath("outputs_video")

    # Read files directly with os.listdir to avoid Windows glob mismatches
    valid_img_exts = ('.png', '.jpg', '.jpeg', '.webp')
    valid_vid_exts = ('.mp4', '.webm', '.mov', '.mkv')

    all_images_raw = natsorted([
        os.path.join(IMAGES_DIR, f) for f in os.listdir(IMAGES_DIR)
        if f.lower().endswith(valid_img_exts)
    ]) if os.path.exists(IMAGES_DIR) else []

    all_videos_raw = natsorted([
        os.path.join(VIDEOS_DIR, f) for f in os.listdir(VIDEOS_DIR)
        if f.lower().endswith(valid_vid_exts)
    ]) if os.path.exists(VIDEOS_DIR) else []

    # =========================================================================
    # EXACT SCENE NUMBERS (60 to 84)
    # =========================================================================
    START_SCENE = 60
    END_SCENE = 84

    def extract_scene_num(filepath):
        # Matches patterns like scene_60.png or scene_60_0.mp4
        match = re.search(r'scene_(\d+)', os.path.basename(filepath), re.IGNORECASE)
        return int(match.group(1)) if match else -1

    selected_images = [img for img in all_images_raw if START_SCENE <= extract_scene_num(img) <= END_SCENE]
    selected_videos = [vid for vid in all_videos_raw if START_SCENE <= extract_scene_num(vid) <= END_SCENE]

    print(f"Folder Status:")
    print(f" -> Total images found: {len(all_images_raw)}")
    print(f" -> Total videos found: {len(all_videos_raw)}")
    print(f"Queued for Rendering:")
    print(f" -> Images selected: {len(selected_images)}")
    print(f" -> Videos selected: {len(selected_videos)}")

    expected_count = END_SCENE - START_SCENE + 1
    if len(selected_videos) < expected_count:
        print(f"\n⚠️ Notice: Selected range expects {expected_count} scenes, but only {len(selected_videos)} videos were matched.")

    render_story_video(
        selected_images,
        selected_videos,
        start_scene_num=START_SCENE,
        output_file=OUTPUT_PATH,
    )