# Changelog

## [0.2.1](https://github.com/haiix/agent-tasks/compare/v0.2.0...v0.2.1) (2026-09-13)


### Changed

* centralize SQLite transactions ([#64](https://github.com/haiix/agent-tasks/issues/64)) ([e56402d](https://github.com/haiix/agent-tasks/commit/e56402d17de99f6dd727329dd76b3d444dede714))
* derive transition values in domain layer ([#67](https://github.com/haiix/agent-tasks/issues/67)) ([7ab8bd6](https://github.com/haiix/agent-tasks/commit/7ab8bd620e61c133c194554b9dbabac4e0381868))
* extract validation primitives ([#68](https://github.com/haiix/agent-tasks/issues/68)) ([2d9b93c](https://github.com/haiix/agent-tasks/commit/2d9b93cae75ba57763df2d747ef5d02b3f3d17a2))
* separate CLI responsibilities ([#69](https://github.com/haiix/agent-tasks/issues/69)) ([10aaa47](https://github.com/haiix/agent-tasks/commit/10aaa47444a1545a4e7f164ab922b56d150aae3e))
* split task storage responsibilities ([#66](https://github.com/haiix/agent-tasks/issues/66)) ([150f19b](https://github.com/haiix/agent-tasks/commit/150f19bfcee0bf2e6334a036a8cbcb989cbc3f94))
* unify storage operation dependencies ([#65](https://github.com/haiix/agent-tasks/issues/65)) ([b1034bf](https://github.com/haiix/agent-tasks/commit/b1034bf399edf1572b3846452e2dba63f7166acd))


### Documentation

* add TSDoc comments and policy ([#73](https://github.com/haiix/agent-tasks/issues/73)) ([82f12e4](https://github.com/haiix/agent-tasks/commit/82f12e44c6d278588a82aeca3e72b148856b0b01))

## [0.2.0](https://github.com/haiix/agent-tasks/compare/v0.1.0...v0.2.0) (2026-09-01)


### Added

* add agent-tasks workflow skill ([#52](https://github.com/haiix/agent-tasks/issues/52)) ([a9cc83b](https://github.com/haiix/agent-tasks/commit/a9cc83bd7c922833909649ed8ac3105081388eaa))
* add project skill installer ([#53](https://github.com/haiix/agent-tasks/issues/53)) ([580812d](https://github.com/haiix/agent-tasks/commit/580812d66a45b1c0ae67557d24220efcd3a42f11))

## 0.1.0 (2026-09-01)


### Added

* add task snapshot export and text output ([#29](https://github.com/haiix/agent-tasks/issues/29)) ([5fa1ef7](https://github.com/haiix/agent-tasks/commit/5fa1ef75f310aeaa60951727de881df30c8caced))
* claimと状態遷移を原子的に実装する ([#28](https://github.com/haiix/agent-tasks/issues/28)) ([258f88e](https://github.com/haiix/agent-tasks/commit/258f88e70b536a8a10f639395967c63c60e6faec))
* **cli:** implement database discovery and init ([#25](https://github.com/haiix/agent-tasks/issues/25)) ([f64e2bf](https://github.com/haiix/agent-tasks/commit/f64e2bf274e45f6f9e0703f3aaae5afb1bcf760d))
* **cli:** implement task CRUD commands ([#26](https://github.com/haiix/agent-tasks/issues/26)) ([6e39f47](https://github.com/haiix/agent-tasks/commit/6e39f472669d093bcb8d4f9ee738c7397ae92457))
* **cli:** タスク依存関係とrunnable判定を実装する ([#27](https://github.com/haiix/agent-tasks/issues/27)) ([64f62a3](https://github.com/haiix/agent-tasks/commit/64f62a31356d5f3285bfca589ee2112ef9c47056))
* implement task domain validation ([#22](https://github.com/haiix/agent-tasks/issues/22)) ([e61d85a](https://github.com/haiix/agent-tasks/commit/e61d85a4e76d1f18a991a3907b239a1fe6acfa96))
* publish CLI package to npm ([#50](https://github.com/haiix/agent-tasks/issues/50)) ([3e6e403](https://github.com/haiix/agent-tasks/commit/3e6e4030328395c73ab17339f9fe9ba57b04556a))
* **storage:** implement SQLite schema and migrations ([#24](https://github.com/haiix/agent-tasks/issues/24)) ([88f0089](https://github.com/haiix/agent-tasks/commit/88f00890f4a94426144b3eb68b162214a1466537))


### Fixed

* accept option-like CLI values ([#39](https://github.com/haiix/agent-tasks/issues/39)) ([2c4c1f1](https://github.com/haiix/agent-tasks/commit/2c4c1f1c0c3c4b022490b5bb3cfd31579c4122bf))
* reject invalid cursor positions ([#38](https://github.com/haiix/agent-tasks/issues/38)) ([a586012](https://github.com/haiix/agent-tasks/commit/a586012d3adcc8d701444f441cfa42cacee650e0))
* validate history status causality ([#37](https://github.com/haiix/agent-tasks/issues/37)) ([0413265](https://github.com/haiix/agent-tasks/commit/0413265556d20298ad117c21b63cfa11e646d2d1))
* verify the saved events in the history ([#33](https://github.com/haiix/agent-tasks/issues/33)) ([984e71d](https://github.com/haiix/agent-tasks/commit/984e71d83a199d1f414894243830ed906b3c112d))


### Documentation

* add a CLI usage prompt for AI agents ([#31](https://github.com/haiix/agent-tasks/issues/31)) ([91cfa07](https://github.com/haiix/agent-tasks/commit/91cfa07b25b0e7d6a0bdc821155f4e1bbfe913c1))
* add project specifications ([#13](https://github.com/haiix/agent-tasks/issues/13)) ([3b70a59](https://github.com/haiix/agent-tasks/commit/3b70a597241bb0d444d81aac6040fd40e9e42c66))
* finalize CLI public interface ([#14](https://github.com/haiix/agent-tasks/issues/14)) ([fa0e841](https://github.com/haiix/agent-tasks/commit/fa0e841bf34d361ba625b20c0d8837ba4989c27f))
* finalize MVP documentation ([#41](https://github.com/haiix/agent-tasks/issues/41)) ([bcb3b9d](https://github.com/haiix/agent-tasks/commit/bcb3b9dacc8daff76f56d7bbe078235daa8a9163))
