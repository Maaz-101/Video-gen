import asyncio
import json
import os
import re
import edge_tts
from mutagen.mp3 import MP3

# --- CREEPY HORROR VOICE PROFILE ---
VOICE = "en-GB-RyanNeural"  # Dark, cold, gothic timbre
RATE = "-14%"  # Slow, unhurried, unsettling delivery
PITCH = "-3Hz"  # Deep, low-end vocal resonance

# Longer suspenseful pause between scenes (in seconds)
SCENE_PAUSE_SEC = 1.8

# Shortened demo scene chunks
story_scenes = [

    {
        "scene_id": 39,

        "text": (
            "They called the police and showed them everything they had found."
            " The officers searched the hidden passage carefully, checking"
            " every opening and narrow section of the walls. At first, they"
            " didn't find anyone. Then one of the officers noticed something"
            " on the dusty floor."
        ),
    },

    {
        "scene_id": 40,

        "text": (
            "There were several cigarette butts lying near the back of the"
            " passage. They weren't old or covered in dust like everything"
            " else. Some of them looked like they had been smoked only"
            " recently. Beside them were a half-empty bottle of water and"
            " a few empty food wrappers."
        ),
    },

    {
        "scene_id": 41,

        "text": (
            "The police searched deeper and found a small blanket, an old"
            " flashlight, and a few personal belongings hidden behind one"
            " of the wall sections. Someone hadn't just discovered the"
            " passage. Someone had been using it. And judging by the fresh"
            " cigarette butts, they might have been there very recently."
        ),
    },

    {
        "scene_id": 42,

        "text": (
            "The officers searched the entire house again, but there was"
            " no sign of anyone. They checked the doors, windows, attic,"
            " basement, and every possible entrance. Whoever had been inside"
            " the passage was gone. The only thing they could confirm was"
            " that the person had known the house well enough to move through"
            " it without being seen."
        ),
    },

    {
        "scene_id": 43,

        "text": (
            "That was enough for them. The couple packed a few bags and"
            " left the house that same night. They didn't care about the"
            " furniture, the money they had spent on the place, or what"
            " would happen to the house afterward. They just wanted to be"
            " somewhere the walls couldn't hide anyone."
        ),
    },

    {
        "scene_id": 44,

        "text": (
            "They never moved back in. A few weeks later, they learned that"
            " the police still hadn't found the person who had been using"
            " the passage. The case was left open, but there was no name,"
            " no face, and no proof of who had been watching them."
        ),
    },

]


def clean_text_for_creepy_narration(raw_text: str) -> str:
    """Formats text with extended pauses to force an eerie, creeping cadence."""
    text = re.sub(r"\.\s+", "... ... ", raw_text)
    text = re.sub(r"!\s+", " — ", text)
    return text.strip()


async def generate_scene_file(text, output_path, max_retries=4):
    """Generates single scene with resume check and backoff."""
    for attempt in range(1, max_retries + 1):
        try:
            communicate = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
            await communicate.save(output_path)
            return True
        except Exception as err:
            wait_time = attempt * 2.5
            if attempt < max_retries:
                print(f"    [Retry {attempt}] Connection busy, waiting {wait_time:.1f}s...")
                await asyncio.sleep(wait_time)
            else:
                raise err


async def generate_combined_audio(
    scenes,
    output_audio="full_story_narration.mp3",
    output_json="scene_timestamps.json",
):
    temp_dir = "temp_audio_chunks"
    os.makedirs(temp_dir, exist_ok=True)

    temp_files = []
    scene_manifest = []
    current_time_marker = 0.0

    print(
        f"Generating creepy horror narration using [{VOICE}] (Rate: {RATE},"
        f" Pitch: {PITCH})...\n"
    )

    for i, scene in enumerate(scenes):
        s_id = scene["scene_id"]
        temp_path = os.path.join(temp_dir, f"temp_chunk_{s_id:03d}.mp3")
        tts_text = clean_text_for_creepy_narration(scene["text"])

        # Overwrite old chunks to apply new voice and text
        await generate_scene_file(tts_text, temp_path)
        temp_files.append(temp_path)

        audio_info = MP3(temp_path)
        speech_duration = audio_info.info.length

        pause_duration = SCENE_PAUSE_SEC if i < len(scenes) - 1 else 0.0
        total_scene_duration = speech_duration + pause_duration

        scene_manifest.append({
            "scene_id": s_id,
            "text": scene["text"],
            "speech_start": round(current_time_marker, 3),
            "speech_end": round(current_time_marker + speech_duration, 3),
            "scene_total_end": round(
                current_time_marker + total_scene_duration, 3
            ),
            "speech_duration": round(speech_duration, 3),
            "total_duration": round(total_scene_duration, 3),
        })

        current_time_marker += total_scene_duration
        print(
            f" -> Scene {s_id} ready ({speech_duration:.2f}s audio +"
            f" {pause_duration}s pause)"
        )

        await asyncio.sleep(1.0)

    print(f"\nMerging chunks into master track: {output_audio}...")
    with open(output_audio, "wb") as outfile:
        for chunk in temp_files:
            with open(chunk, "rb") as infile:
                outfile.write(infile.read())
            try:
                os.remove(chunk)
            except OSError:
                pass

    try:
        os.rmdir(temp_dir)
    except OSError:
        pass

    with open(output_json, "w", encoding="utf-8") as jf:
        json.dump(scene_manifest, jf, indent=2)

    print(f"\n[SUCCESS] Master audio saved to: {output_audio}")
    print(f"[SUCCESS] Scene timestamps saved to: {output_json}")
    print(f"Total track length: {current_time_marker:.2f} seconds")


if __name__ == "__main__":
    asyncio.run(generate_combined_audio(story_scenes))