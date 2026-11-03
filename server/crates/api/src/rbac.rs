//! Per-project roles and the permission matrix (PRD §5.10). Membership is cached in memory and reloaded
//! whenever it changes through the API.

use std::collections::HashMap;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Member,
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Member => "member",
            Role::Admin => "admin",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "viewer" => Some(Role::Viewer),
            "member" => Some(Role::Member),
            "admin" => Some(Role::Admin),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Perm {
    /// Create projects, manage users.
    ManageUsersAndProjects,
    /// Project settings, keys, Telegram, remote config, members.
    ProjectSettings,
    /// View issues, sessions, replays.
    View,
    /// View network headers/bodies & WS frame contents.
    ViewSensitive,
    /// Change issue status.
    ChangeIssueStatus,
    /// Delete sessions / issues.
    Delete,
}

/// The §5.10 matrix. `role` is the user's role in the project (None = not a member).
pub fn allowed(is_superadmin: bool, role: Option<Role>, perm: Perm) -> bool {
    if is_superadmin {
        return true;
    }
    let Some(r) = role else { return false };
    match perm {
        Perm::ManageUsersAndProjects => false,
        Perm::ProjectSettings | Perm::Delete => r >= Role::Admin,
        Perm::View => r >= Role::Viewer,
        Perm::ViewSensitive | Perm::ChangeIssueStatus => r >= Role::Member,
    }
}

#[derive(Default)]
pub struct Members {
    map: RwLock<HashMap<(i32, i32), Role>>,
}

impl Members {
    pub fn role(&self, user_id: i32, project_id: i32) -> Option<Role> {
        self.map.read().get(&(user_id, project_id)).copied()
    }

    pub fn projects_of(&self, user_id: i32) -> Vec<(i32, Role)> {
        let mut v: Vec<_> = self
            .map
            .read()
            .iter()
            .filter(|((u, _), _)| *u == user_id)
            .map(|((_, p), r)| (*p, *r))
            .collect();
        v.sort();
        v
    }

    pub async fn reload(&self, c: &replayd_db::tokio_postgres::Client) -> Result<(), replayd_db::DbError> {
        let rows = c
            .query("SELECT user_id, project_id, role::text FROM project_members", &[])
            .await?;
        let mut m = HashMap::with_capacity(rows.len());
        for r in rows {
            let role: String = r.get(2);
            if let Some(role) = Role::parse(&role) {
                m.insert((r.get(0), r.get(1)), role);
            }
        }
        *self.map.write() = m;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Full §5.10 matrix: rows = permissions, columns = superadmin, admin, member, viewer, non-member.
    #[test]
    fn rbac_matrix() {
        let cols: [(bool, Option<Role>); 5] = [
            (true, None),
            (false, Some(Role::Admin)),
            (false, Some(Role::Member)),
            (false, Some(Role::Viewer)),
            (false, None),
        ];
        let matrix = [
            (Perm::ManageUsersAndProjects, [true, false, false, false, false]),
            (Perm::ProjectSettings, [true, true, false, false, false]),
            (Perm::View, [true, true, true, true, false]),
            (Perm::ViewSensitive, [true, true, true, false, false]),
            (Perm::ChangeIssueStatus, [true, true, true, false, false]),
            (Perm::Delete, [true, true, false, false, false]),
        ];
        for (perm, expect) in matrix {
            for (i, (sa, role)) in cols.iter().enumerate() {
                assert_eq!(allowed(*sa, *role, perm), expect[i], "{perm:?} col {i}");
            }
        }
    }
}
