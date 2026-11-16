//! Model capabilities follow Pi 1.5's getSupportedThinkingLevels semantics.
//! Null explicitly disables a level; omitted normal levels retain Pi defaults.

use pi_rpc::{Error, PiClient, Result};
use serde_json::Value;

const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn thinking_levels(model: &Value) -> Vec<&'static str> {
    if model.get("reasoning").and_then(Value::as_bool) != Some(true) {
        return vec!["off"];
    }
    LEVELS
        .into_iter()
        .filter(|level| {
            let mapped = model
                .get("thinkingLevelMap")
                .and_then(|map| map.get(*level));
            if mapped.is_some_and(Value::is_null) {
                return false;
            }
            !matches!(*level, "xhigh" | "max") || mapped.is_some()
        })
        .collect()
}

pub fn annotate_catalog(catalog: &mut Value) {
    if let Some(models) = catalog.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            let levels = thinking_levels(model);
            model["supportedThinkingLevels"] = serde_json::json!(levels);
        }
    }
}

fn rejected(message: impl Into<String>) -> Error {
    Error::Rpc {
        command: "configure_model".into(),
        message: message.into(),
    }
}

fn matches_selection(state: &Value, provider: &str, model_id: &str, level: &str) -> bool {
    state["model"]["provider"].as_str() == Some(provider)
        && state["model"]["id"].as_str() == Some(model_id)
        && state["thinkingLevel"].as_str() == Some(level)
}

/// Validate and apply both choices while the caller holds the session lock.
/// A failed partial change restores the previous model and thinking level.
pub fn configure(client: &PiClient, provider: &str, model_id: &str, level: &str) -> Result<Value> {
    let catalog = client.get_available_models()?;
    let target = catalog["models"]
        .as_array()
        .and_then(|models| {
            models.iter().find(|model| {
                model["provider"].as_str() == Some(provider)
                    && model["id"].as_str() == Some(model_id)
            })
        })
        .ok_or_else(|| rejected("所选模型已不可用，请刷新模型列表"))?;
    if !thinking_levels(target).contains(&level) {
        return Err(rejected(format!(
            "所选模型不支持 {level} 思考强度，请重新选择"
        )));
    }
    let previous = client.get_state()?;
    if previous["isStreaming"].as_bool() == Some(true)
        || previous["isCompacting"].as_bool() == Some(true)
    {
        return Err(rejected("当前任务正在运行，请结束后再切换模型"));
    }
    if matches_selection(&previous, provider, model_id, level) {
        return Ok(previous);
    }
    let old_provider = previous["model"]["provider"].as_str();
    let old_id = previous["model"]["id"].as_str();
    let old_level = previous["thinkingLevel"].as_str().unwrap_or("off");
    let apply = (|| {
        if old_provider != Some(provider) || old_id != Some(model_id) {
            client.set_model(provider, model_id)?;
        }
        client.set_thinking_level(level)?;
        let state = client.get_state()?;
        if !matches_selection(&state, provider, model_id, level) {
            return Err(rejected("Pi 返回的模型或思考强度与选择不一致"));
        }
        Ok(state)
    })();
    match apply {
        Ok(state) => Ok(state),
        Err(error) => {
            let rollback = (|| {
                let (Some(old_provider), Some(old_id)) = (old_provider, old_id) else {
                    return Err(rejected("原会话没有可恢复的模型"));
                };
                client.set_model(old_provider, old_id)?;
                client.set_thinking_level(old_level)?;
                let restored = client.get_state()?;
                if !matches_selection(&restored, old_provider, old_id, old_level) {
                    return Err(rejected("Pi 未能恢复原设置"));
                }
                Ok(())
            })();
            match rollback {
                Ok(()) => Err(rejected(format!("{error}；已恢复原模型和思考强度"))),
                Err(restore_error) => Err(rejected(format!(
                    "{error}；恢复原设置失败：{restore_error}。请检查当前会话状态"
                ))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_reasoning_models_only_offer_off() {
        assert_eq!(thinking_levels(&json!({"reasoning": false})), ["off"]);
        assert_eq!(thinking_levels(&json!({})), ["off"]);
    }

    #[test]
    fn absent_map_uses_pi_standard_levels_without_extended_levels() {
        assert_eq!(
            thinking_levels(&json!({"reasoning": true})),
            ["off", "minimal", "low", "medium", "high"]
        );
    }

    #[test]
    fn null_disables_levels_but_omitted_standard_levels_remain_supported() {
        assert_eq!(
            thinking_levels(&json!({"reasoning": true, "thinkingLevelMap": {
                "minimal": null, "medium": null, "xhigh": "extra", "max": null
            }})),
            ["off", "low", "high", "xhigh"]
        );
    }

    #[test]
    fn step_and_deepseek_preserve_their_different_choices() {
        let mut model = json!({"reasoning": true, "thinkingLevelMap": {
            "off": null, "minimal": null, "low": "low", "medium": null,
            "high": "high", "xhigh": null, "max": null
        }});
        assert_eq!(thinking_levels(&model), ["low", "high"]);
        model["thinkingLevelMap"]["off"] = json!("none");
        model["thinkingLevelMap"]["max"] = json!("max");
        assert_eq!(thinking_levels(&model), ["off", "low", "high", "max"]);
    }

    #[test]
    fn catalog_annotation_keeps_the_original_model_metadata() {
        let mut catalog = json!({"models":[{"id":"example","reasoning":false}]});
        annotate_catalog(&mut catalog);
        assert_eq!(catalog["models"][0]["id"], "example");
        assert_eq!(
            catalog["models"][0]["supportedThinkingLevels"],
            json!(["off"])
        );
    }
}
