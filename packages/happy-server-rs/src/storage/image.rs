//! `storage/processImage.ts` and `storage/thumbhash.ts`.

use image::{GenericImageView, ImageFormat};

pub struct Processed {
    pub width: u32,
    pub height: u32,
    pub thumbhash: String,
    pub png: bool,
}

/// PNG or JPEG only; the thumbhash is computed on a ≤100×100 resize.
pub fn process_image(src: &[u8]) -> anyhow::Result<Processed> {
    let format = image::guess_format(src)?;
    if format != ImageFormat::Png && format != ImageFormat::Jpeg {
        anyhow::bail!("Unsupported image format");
    }
    let img = image::load_from_memory_with_format(src, format)?;
    let (width, height) = img.dimensions();
    let (mut tw, mut th) = (100u32, 100u32);
    if width > height {
        th = js_round(height as f64 * 100.0 / width as f64) as u32;
    } else if height > width {
        tw = js_round(width as f64 * 100.0 / height as f64) as u32;
    }
    if tw == 0 || th == 0 {
        anyhow::bail!("Expected positive integer for {} but received 0", if tw == 0 { "width" } else { "height" });
    }
    let rgba = if (tw, th) == (width, height) {
        img.to_rgba8()
    } else {
        img.resize_exact(tw, th, image::imageops::FilterType::Lanczos3).to_rgba8()
    };
    let hash = thumbhash(tw as usize, th as usize, rgba.as_raw());
    Ok(Processed { width, height, thumbhash: crate::util::b64_encode(&hash), png: format == ImageFormat::Png })
}

/// `Math.round`.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// The TS `thumbhash` (evanw's encoder, in doubles).
pub fn thumbhash(w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
    use std::f64::consts::PI;
    let px = |i: usize, c: usize| rgba[i * 4 + c] as f64;
    let (mut avg_r, mut avg_g, mut avg_b, mut avg_a) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..w * h {
        let alpha = px(i, 3) / 255.0;
        avg_r += alpha / 255.0 * px(i, 0);
        avg_g += alpha / 255.0 * px(i, 1);
        avg_b += alpha / 255.0 * px(i, 2);
        avg_a += alpha;
    }
    if avg_a != 0.0 {
        avg_r /= avg_a;
        avg_g /= avg_a;
        avg_b /= avg_a;
    }

    let has_alpha = avg_a < (w * h) as f64;
    let l_limit = if has_alpha { 5.0 } else { 7.0 };
    let lx = js_round(l_limit * w as f64 / w.max(h) as f64).max(1.0) as usize;
    let ly = js_round(l_limit * h as f64 / w.max(h) as f64).max(1.0) as usize;
    let (mut l, mut p, mut q, mut a) = (Vec::with_capacity(w * h), Vec::with_capacity(w * h), Vec::with_capacity(w * h), Vec::with_capacity(w * h));
    for i in 0..w * h {
        let alpha = px(i, 3) / 255.0;
        let r = avg_r * (1.0 - alpha) + alpha / 255.0 * px(i, 0);
        let g = avg_g * (1.0 - alpha) + alpha / 255.0 * px(i, 1);
        let b = avg_b * (1.0 - alpha) + alpha / 255.0 * px(i, 2);
        l.push((r + g + b) / 3.0);
        p.push((r + g) / 2.0 - b);
        q.push(r - g);
        a.push(alpha);
    }

    let encode = |channel: &[f64], nx: usize, ny: usize| -> (f64, Vec<f64>, f64) {
        let (mut dc, mut ac, mut scale) = (0.0, Vec::new(), 0.0f64);
        let mut fx = vec![0.0; w];
        for cy in 0..ny {
            let mut cx = 0;
            while cx * ny < nx * (ny - cy) {
                let mut f = 0.0;
                for (x, v) in fx.iter_mut().enumerate() {
                    *v = (PI / w as f64 * cx as f64 * (x as f64 + 0.5)).cos();
                }
                for y in 0..h {
                    let fy = (PI / h as f64 * cy as f64 * (y as f64 + 0.5)).cos();
                    for x in 0..w {
                        f += channel[x + y * w] * fx[x] * fy;
                    }
                }
                f /= (w * h) as f64;
                if cx > 0 || cy > 0 {
                    ac.push(f);
                    scale = scale.max(f.abs());
                } else {
                    dc = f;
                }
                cx += 1;
            }
        }
        if scale != 0.0 {
            for v in ac.iter_mut() {
                *v = 0.5 + 0.5 / scale * *v;
            }
        }
        (dc, ac, scale)
    };
    let (l_dc, l_ac, l_scale) = encode(&l, lx.max(3), ly.max(3));
    let (p_dc, p_ac, p_scale) = encode(&p, 3, 3);
    let (q_dc, q_ac, q_scale) = encode(&q, 3, 3);
    let (a_dc, a_ac, a_scale) = if has_alpha { encode(&a, 5, 5) } else { (0.0, vec![0.0], 0.0) };

    // JS bitwise operators work on int32.
    let r = |x: f64| js_round(x) as i64 as i32;
    let landscape = w > h;
    let header24 = r(63.0 * l_dc) | (r(31.5 + 31.5 * p_dc) << 6) | (r(31.5 + 31.5 * q_dc) << 12) | (r(31.0 * l_scale) << 18) | ((has_alpha as i32) << 23);
    let header16 = (if landscape { ly } else { lx }) as i32 | (r(63.0 * p_scale) << 3) | (r(63.0 * q_scale) << 9) | ((landscape as i32) << 15);
    let mut hash: Vec<i32> = vec![header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8];
    let ac_start = if has_alpha { 6 } else { 5 };
    if has_alpha {
        hash.push(r(15.0 * a_dc) | (r(15.0 * a_scale) << 4));
    }
    let mut index = 0usize;
    let groups: Vec<&Vec<f64>> = if has_alpha { vec![&l_ac, &p_ac, &q_ac, &a_ac] } else { vec![&l_ac, &p_ac, &q_ac] };
    for ac in groups {
        for f in ac {
            let at = ac_start + (index >> 1);
            if hash.len() <= at {
                hash.resize(at + 1, 0);
            }
            hash[at] |= r(15.0 * f) << ((index & 1) << 2);
            index += 1;
        }
    }
    // `new Uint8Array(hash)` keeps the low byte.
    hash.into_iter().map(|v| v as u8).collect()
}
