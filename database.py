import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB  = os.getenv("MONGO_DB", "comparer")

_client: MongoClient | None = None


def get_client() -> MongoClient:
    global _client
    if _client is None:
        _client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
    return _client


def get_db():
    """FastAPI dependency — yields pymongo Database object."""
    return get_client()[MONGO_DB]


def next_id(collection_name: str) -> int:
    """Auto-increment emulation using a counters collection."""
    db = get_client()[MONGO_DB]
    result = db["counters"].find_one_and_update(
        {"_id": collection_name},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    return result["seq"]
