"""Register the SQL Server allowlist from application settings."""


def register_configured(settings, registry):
    if not isinstance(settings.datasets, list) or not settings.datasets or not all(
        isinstance(table, dict) for table in settings.datasets
    ) or not isinstance(settings.dataset_defaults, dict):
        raise ValueError("Define one or more [[datasets]] entries and optional [dataset_defaults].")
    payloads = []
    for table in settings.datasets:
        payload = {**settings.dataset_defaults, **table}
        payload.setdefault("name", payload.get("source_table"))
        name = payload.get("connection_name")
        if not isinstance(name, str) or name not in settings.connections:
            raise ValueError("Each configured dataset must name a configured SQL Server connection.")
        if payload.get("mode") == "cdc" and not payload.get("capture_instance"):
            raise ValueError("CDC requires capture_instance for each configured CDC dataset.")
        payloads.append(payload)
    return registry.register_datasets(payloads, reuse_existing=True)
