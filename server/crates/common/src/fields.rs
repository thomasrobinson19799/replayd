//! Validation for the SDK's bounded custom-field snapshots.
pub fn valid_custom(value: &serde_json::Value) -> bool {
    fn depth(v: &serde_json::Value, n: usize) -> bool {
        match v {
            serde_json::Value::Object(m) => n < 8 && m.values().all(|x| depth(x, n + 1)),
            serde_json::Value::Array(a) => n < 8 && a.iter().all(|x| depth(x, n + 1)),
            _ => true,
        }
    }
    value.is_object() && depth(value, 0) && serde_json::to_vec(value).is_ok_and(|b| b.len() <= 16 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn custom_snapshots_respect_byte_and_depth_limits() {
        assert!(valid_custom(&json!({"x":"x".repeat(16*1024-8)})));
        assert!(!valid_custom(&json!({"x":"x".repeat(16*1024)})));
        assert!(!valid_custom(&json!({"x":"💚".repeat(5000)})));
        let mut nested = json!("leaf");
        for _ in 0..7 {
            nested = json!({"child":nested});
        }
        assert!(valid_custom(&json!({"root":nested})));
        assert!(!valid_custom(&json!({"root":{"child":nested}})));
    }
}
