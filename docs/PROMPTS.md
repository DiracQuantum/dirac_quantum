# Промпты на персонажей Dirac

Стиль-якорь (вставляется в начало каждого промпта, уже вставлен ниже):

> Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow.

Как работать:
1. Генерация: Midjourney v7: промпт + параметры одной строкой. Flux: тот же текст без `--`-параметров, список из `--no` перенести в negative prompt. Фон должен быть чисто чёрным. Выбрать лучший вариант, сделать Upscale.
2. Удаление фона: загрузить апскейл в remove.bg или Photoroom, убрать чёрный фон, проверить, что свечение по краям не съедено, при необходимости подчистить ореол.
3. Экспорт: 2048×2048, PNG с прозрачностью, без сжатия, имя файла точно как ниже. Положить в `public/characters/`.

---

## pet-cat.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A small cat sitting upright, tail curled around its front paws, front three-quarter view, floating slightly, filling about two thirds of the frame height. Body: a sparse lattice of glowing points joined by thin wireframe filaments over a frosted-glass core, matte black resin only at paw tips and ear tips; eyes are two bright cold-blue points. Round head, two triangular ears, compact body: the silhouette reads as a cat at thumbnail size. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

Проверить: читается ли кот в миниатюре 64 px (уши, хвост, два глаза-точки); фон чисто чёрный, без тени под фигурой.

## fighter-hadamard.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. Hadamard: tall, symmetrical humanoid, full body, idle guard stance facing right in slight three-quarter view, both halves visible, feet shoulder-width, knees soft, hands raised in guard, a thin rectangular mirror plane held along the leading forearm like a shield blade. Body split down the vertical centerline: left half solid matte black resin, right half the same form as a translucent frosted-glass lattice of glowing points and wireframe filaments. Figure fills about 85 percent of frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, second character, cropped limbs
```

Проверить: смотрит вправо, обе половины видны (чёрная и решётка), ступни не обрезаны, зеркальная плоскость одна, чёрная половина не сливается с фоном.

## fighter-hadamard-attack.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. Hadamard mid-strike: tall, symmetrical humanoid, full body, lunging right in three-quarter view, front knee bent, rear leg extended, leading arm swinging a thin rectangular mirror plane in a horizontal slash, trailing arm pulled back. Body split down the vertical centerline: left half solid matte black resin, right half the same form as a translucent frosted-glass lattice of glowing points and wireframe filaments, flaring brighter along the striking arm. Figure fills 85 percent of frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, second character, motion blur, cropped limbs
```

Проверить: та же фигура, что в idle (пропорции, раздел тела, зеркало), удар вправо, высота в кадре совпадает с idle, без motion blur.

## fighter-pauli.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. Pauli: compact, heavy, grounded humanoid, broad shoulders, short legs, full body, idle guard stance facing right in three-quarter view, feet planted wide, oversized fists in massive squared gauntlets raised before the chest. Materials inverted top to bottom: head and upper torso a translucent frosted-glass lattice of glowing points and wireframe filaments, hips, legs and gauntlets solid matte black resin, a crisp glowing X seam across the chest. Figure fills 85 percent of frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, second character, weapon, cropped limbs
```

Проверить: приземистый и тяжелее Хадамарда, без оружия, X-шов на груди виден, кулаки крупные, масштаб и ракурс совпадают с другим бойцом.

## fighter-pauli-attack.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. Pauli mid-strike: compact, heavy, grounded humanoid, broad shoulders, short legs, full body, deep lunge facing right in three-quarter view, leading gauntlet thrown in a straight punch, trailing fist cocked at the hip. Materials inverted top to bottom: head and upper torso a translucent frosted-glass lattice of glowing points and wireframe filaments, hips, legs and massive squared gauntlets solid matte black resin, a crisp glowing X seam across the chest. Figure fills 85 percent of frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, second character, weapon, motion blur, cropped limbs
```

Проверить: та же фигура, что в idle Паули, удар вправо, бьющий кулак полностью в кадре, высота в кадре совпадает с idle, без motion blur.

---

# Формы Quantum Pet (семь остальных)

Файлы в `public/characters`: `pet-virus.png`, `pet-black-hole.png`, `pet-cube.png`, `pet-moth.png`, `pet-jellyfish.png`, `pet-crystal.png`, `pet-fox.png`. Требования те же, что у кота. Стилевой якорь тот же, он уже в каждом промпте. Фон удалять не нужно.

## pet-virus.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A quantum virus creature: a spiky frosted-glass sphere with twelve short protein-like spikes ending in matte black tips, a lattice of glowing points and filaments across the shell, two bright cold-blue eyes set into the front, floating slightly, filling two thirds of the frame height. Reads as a playful virus at thumbnail size. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

## pet-black-hole.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A black hole creature: a perfectly matte black sphere with a thin tilted ring of frosted glass around it, the ring lit by a lattice of glowing points and filaments, two small cold-blue eyes glowing from the dark sphere, floating slightly, filling two thirds of the frame height. The sphere must stay visible against the background through its glowing rim. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

## pet-cube.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A sentient cube creature: a frosted-glass cube with softly rounded edges, matte black corner caps, a lattice of glowing points and filaments inside, two bright cold-blue eyes on the front face, standing on one corner and floating slightly, filling two thirds of the frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

## pet-moth.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A moth creature seen from the front with wings spread: frosted-glass wings veined with glowing filaments and points, a matte black furry body and antennae, two bright cold-blue eyes, floating slightly, filling two thirds of the frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

## pet-jellyfish.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A jellyfish creature: a frosted-glass bell with a lattice of glowing points inside, eight trailing tentacles of thin glowing filaments with matte black tips, two bright cold-blue eyes on the bell, floating slightly, filling two thirds of the frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

## pet-crystal.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A crystal creature: a cluster of frosted-glass prisms growing from a matte black base, glowing points and filaments running through the facets, two bright cold-blue eyes in the tallest prism, floating slightly, filling two thirds of the frame height. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

## pet-fox.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A small fox sitting upright, bushy tail curled around its paws, front three-quarter view, floating slightly, filling two thirds of the frame height. Body: a frosted-glass core under a lattice of glowing points and filaments, matte black resin only at the paw tips, ear tips and nose; eyes are two bright cold-blue points; large triangular ears. Reads as a fox at thumbnail size. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, watermark, logo, frame, floor, ground shadow, background objects, multiple views, humans
```

---

# Логотип Dirac (объёмный рендер знака ⟩)

На сайте логотип векторный. Рендеры нужны для аватаров X и pump.fun, баннеров и превью. Требование: читаться в 64 пикселя, скобка одна и толстая, без букв.

## logo-mark.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. The logo mark of Dirac: a single bold right angle bracket ⟩, the closing bracket of Dirac's ket notation, built as a thick chevron of frosted glass with rounded ends, a lattice of glowing points and filaments inside, matte black resin caps on both tips, floating slightly, filling two thirds of the frame height, perfectly centered, no letters, no other shapes. Reads clearly at icon size. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, letters, watermark, frame, floor, ground shadow, background objects, multiple views
```

## logo-seal.png

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; slightly low 50mm camera; single isolated subject centered on a plain pure black background, no ground shadow. A round wax-seal medallion of frosted glass with a matte black rim, a lattice of glowing points and filaments inside the glass, and a bold right angle bracket ⟩ embossed in the center as a raised matte black chevron with cold-blue rim light, floating slightly, filling two thirds of the frame height, no letters. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, letters, watermark, frame, floor, ground shadow, background objects, multiple views
```

## logo-coin.png (аватар токена)

```
Sculpted collectible designer figure in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing the silhouette; camera straight on; single isolated subject centered on a plain pure black background, no ground shadow. A thick round coin seen exactly from the front, matte black resin face with a frosted-glass rim lit by a lattice of glowing points, a large bold right angle bracket ⟩ raised in frosted glass in the center with glowing filaments inside, the coin fills ninety percent of the frame, no letters, no numbers. Must stay readable at 64 pixels. --ar 1:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, letters, numbers, watermark, frame, floor, ground shadow, background objects, multiple views
```

---

# Баннер X (1500×500, 3:1)

Важное держать в центре и справа: на телефоне виден только центр, слева внизу баннер перекрыт аватаркой. Текст не генерировать, слоган накладывается потом шрифтами сайта.

## banner-cast.png

```
Sculpted collectible designer figures in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light tracing every silhouette; slightly low 50mm camera; plain pure black background, no ground shadow, no text. A wide cinematic lineup centered and slightly to the right of the frame: a small frosted-glass cat with a lattice of glowing points sitting in the middle, a tall split-body warrior half matte black half glowing lattice holding a thin mirror blade on its left, a heavy stone-gauntlet brawler with a glowing X seam on the chest on its right, and a large bold right angle bracket ⟩ of frosted glass floating above them as a logo mark; the left third of the frame stays empty and dark for a title; faint drifting points of light like a sparse lattice in the depth. --ar 3:1 --v 7 --style raw --stylize 120 --no purple, magenta, violet, neon rainbow, cyberpunk, text, letters, watermark, frame, floor, ground shadow, crowd, buildings
```

## banner-lattice.png

```
Wide cinematic still on a plain pure black background, no text. A vast sparse three-dimensional lattice of tiny glowing points connected by thin filaments of cold blue and warm white, seen in perspective fading into darkness, with a single wireframe sphere of frosted glass floating right of center and a bold frosted-glass right angle bracket ⟩ with matte black tips in front of it, soft studio key light from upper left, crisp cold-blue rim light, deep falloff; the left third of the frame stays empty and dark for a title. --ar 3:1 --v 7 --style raw --stylize 100 --no purple, magenta, violet, neon rainbow, cyberpunk, text, letters, watermark, frame, floor, people, creatures
```

## Баннер с текстом (генераторы ненадёжно рисуют длинные фразы)

### banner-text-short.png

```
Sculpted collectible designer figures in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light; slightly low 50mm camera; plain pure black background, no ground shadow. Wide cinematic banner: on the left third, the word "DIRAC" in huge heavy condensed uppercase sans-serif letters in warm off-white, clean and perfectly legible, with a bold frosted-glass right angle bracket ⟩ before it; on the right two thirds, a lineup of a small frosted-glass lattice cat sitting in the middle, a tall split-body warrior half matte black half glowing lattice with a thin mirror blade on its left, and a heavy stone-gauntlet brawler with a glowing X seam on the chest on its right; faint drifting points of light in the depth. --ar 3:1 --v 7 --style raw --stylize 100 --no purple, magenta, violet, neon rainbow, cyberpunk, extra text, misspelled letters, watermark, frame, floor, ground shadow, crowd, buildings
```

### banner-text-full.png

```
Sculpted collectible designer figures in matte black resin, frosted glass and thin glowing filaments of cold blue and warm white; one soft studio key light from upper left, deep falloff, crisp cold-blue rim light; slightly low 50mm camera; plain pure black background, no ground shadow. Wide cinematic banner: on the left third, two lines of text in warm off-white, the first line "DIRAC" in huge heavy condensed uppercase sans-serif, the second line "Identity that survives Q-Day." in an elegant italic serif, clean and perfectly legible; on the right two thirds, a lineup of a small frosted-glass lattice cat sitting in the middle, a tall split-body warrior half matte black half glowing lattice with a thin mirror blade on its left, and a heavy stone-gauntlet brawler with a glowing X seam on the chest on its right, with a bold frosted-glass right angle bracket ⟩ floating above them; faint drifting points of light in the depth. --ar 3:1 --v 7 --style raw --stylize 100 --no purple, magenta, violet, neon rainbow, cyberpunk, extra text, misspelled letters, watermark, frame, floor, ground shadow, crowd, buildings
```
