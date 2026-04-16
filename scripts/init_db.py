from mriqc_aggregator.database import create_database_schema, default_database_url


if __name__ == "__main__":
    url = default_database_url()
    print(f"Initializing schema at {url}")
    create_database_schema(url=url)
