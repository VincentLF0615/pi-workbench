//! Validated image attachments shared by the CLI and desktop boundary.
use crate::{Error, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_IMAGES_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: String,
    pub mime_type: String,
}

pub fn validate_images(images: &[ImageContent]) -> Result<()> {
    let mut total = 0usize;
    if images.len() > 32 {
        return Err(Error::Protocol("一次最多发送 32 张图片".into()));
    }
    for image in images {
        if image.kind != "image"
            || !matches!(
                image.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            )
        {
            return Err(Error::Protocol("仅支持 PNG、JPEG、WebP、GIF 图片".into()));
        }
        if image.data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err(Error::Protocol("单张图片不能超过 10 MiB".into()));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&image.data)
            .map_err(|_| Error::Protocol("图片 base64 数据无效".into()))?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(Error::Protocol("图片为空或超过 10 MiB".into()));
        }
        total += bytes.len();
        if total > MAX_IMAGES_BYTES {
            return Err(Error::Protocol("图片合计不能超过 20 MiB".into()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(data: &str) -> ImageContent {
        ImageContent {
            kind: "image".into(),
            data: data.into(),
            mime_type: "image/png".into(),
        }
    }
    #[test]
    fn validates_wire_images() {
        assert!(validate_images(&[]).is_ok());
        assert!(validate_images(&[image("aGk=")]).is_ok());
        assert!(validate_images(&[image("data:image/png;base64,aGk=")]).is_err());
        assert!(validate_images(&[image("")]).is_err());
        let mut bad = image("aGk=");
        bad.mime_type = "image/svg+xml".into();
        assert!(validate_images(&[bad]).is_err());
    }
    #[test]
    fn caps_image_bytes() {
        let data = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_IMAGE_BYTES]);
        assert!(validate_images(&[image(&data), image(&data)]).is_ok());
        assert!(validate_images(&[image(&data), image(&data), image("aGk=")]).is_err());
        assert!(validate_images(&[image(&(data + "AAAA"))]).is_err());
    }
}
