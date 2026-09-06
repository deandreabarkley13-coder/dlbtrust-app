// trustnotary — the chaincode side of the DLB Trust notarization gap.
//
// The channel never holds trust money or the record itself: it holds a digest
// of the record as it existed when a trustee notarized it, plus whatever
// metadata the caller wants pinned alongside it. Fabric's job here is to make
// the digest impossible to revise quietly — every NotarizeRecord appends to an
// immutable history keyed by (recordType, recordId), so a record edited after
// the fact stops hashing to what the channel already committed.
package main

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type NotaryContract struct {
	contractapi.Contract
}

// Notarization is the latest digest committed for a record.
type Notarization struct {
	RecordType  string `json:"recordType"`
	RecordID    string `json:"recordId"`
	Digest      string `json:"digest"`
	Metadata    string `json:"metadata"`
	TxID        string `json:"txId"`
	NotarizedAt string `json:"notarizedAt"`
	Version     int    `json:"version"`
}

const recordNamespace = "notarization"
const historyNamespace = "notarization-history"

func recordKey(ctx contractapi.TransactionContextInterface, recordType, recordID string) (string, error) {
	return ctx.GetStub().CreateCompositeKey(recordNamespace, []string{recordType, recordID})
}

func historyKey(ctx contractapi.TransactionContextInterface, recordType, recordID string, version int) (string, error) {
	return ctx.GetStub().CreateCompositeKey(historyNamespace, []string{recordType, recordID, fmt.Sprintf("%09d", version)})
}

// NotarizeRecord commits a digest for a record. Re-notarizing the same digest
// is a no-op beyond bumping nothing; a *different* digest is appended as a new
// version rather than replacing the old one, so the earlier commitment stays
// on the channel for an auditor to find.
func (c *NotaryContract) NotarizeRecord(ctx contractapi.TransactionContextInterface, recordType, recordID, digest, metadata string) (string, error) {
	if recordType == "" || recordID == "" || digest == "" {
		return "", fmt.Errorf("recordType, recordId and digest are all required")
	}
	if len(digest) != 64 {
		return "", fmt.Errorf("digest must be a 64-character sha256 hex string")
	}

	key, err := recordKey(ctx, recordType, recordID)
	if err != nil {
		return "", err
	}

	existingBytes, err := ctx.GetStub().GetState(key)
	if err != nil {
		return "", err
	}

	version := 1
	if len(existingBytes) > 0 {
		var existing Notarization
		if err := json.Unmarshal(existingBytes, &existing); err != nil {
			return "", err
		}
		if existing.Digest == digest {
			return string(existingBytes), nil
		}
		version = existing.Version + 1
	}

	timestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", err
	}

	record := Notarization{
		RecordType:  recordType,
		RecordID:    recordID,
		Digest:      digest,
		Metadata:    metadata,
		TxID:        ctx.GetStub().GetTxID(),
		NotarizedAt: timestamp.AsTime().UTC().Format("2006-01-02T15:04:05Z"),
		Version:     version,
	}

	encoded, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	if err := ctx.GetStub().PutState(key, encoded); err != nil {
		return "", err
	}

	hKey, err := historyKey(ctx, recordType, recordID, version)
	if err != nil {
		return "", err
	}
	if err := ctx.GetStub().PutState(hKey, encoded); err != nil {
		return "", err
	}

	return string(encoded), nil
}

// GetRecord returns the latest notarization for a record, or an empty result
// when the record was never notarized — the caller must not read silence as
// agreement.
func (c *NotaryContract) GetRecord(ctx contractapi.TransactionContextInterface, recordType, recordID string) (string, error) {
	key, err := recordKey(ctx, recordType, recordID)
	if err != nil {
		return "", err
	}
	stored, err := ctx.GetStub().GetState(key)
	if err != nil {
		return "", err
	}
	if len(stored) == 0 {
		empty, _ := json.Marshal(map[string]interface{}{
			"recordType": recordType,
			"recordId":   recordID,
			"digest":     "",
			"notarized":  false,
		})
		return string(empty), nil
	}
	return string(stored), nil
}

// GetRecordHistory returns every digest ever committed for a record, oldest
// first, which is what an auditor walks when a mismatch shows up.
func (c *NotaryContract) GetRecordHistory(ctx contractapi.TransactionContextInterface, recordType, recordID string) (string, error) {
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey(historyNamespace, []string{recordType, recordID})
	if err != nil {
		return "", err
	}
	defer iterator.Close()

	versions := []Notarization{}
	for iterator.HasNext() {
		item, err := iterator.Next()
		if err != nil {
			return "", err
		}
		var entry Notarization
		if err := json.Unmarshal(item.Value, &entry); err != nil {
			return "", err
		}
		versions = append(versions, entry)
	}

	encoded, err := json.Marshal(versions)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func main() {
	chaincode, err := contractapi.NewChaincode(&NotaryContract{})
	if err != nil {
		panic(fmt.Sprintf("failed to create trustnotary chaincode: %v", err))
	}
	if err := chaincode.Start(); err != nil {
		panic(fmt.Sprintf("failed to start trustnotary chaincode: %v", err))
	}
}
