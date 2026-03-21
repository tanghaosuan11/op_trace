use revm::{
    context::{
        journaled_state::{account::JournaledAccount, AccountInfoLoad, JournalLoadError},
    },
    context_interface::{
        journaled_state::{AccountLoad, JournalCheckpoint, TransferError},
        JournalTr, 
    },
 
    inspector::{ JournalExt},
    interpreter::{SStoreResult,
        SelfDestructResult, StateLoad,
    },
    primitives::{
         hardfork::SpecId, Address, AddressMap, AddressSet,
        HashSet, Log, StorageKey, StorageValue, B256, U256,
    },
    state::{Account,  Bytecode, EvmState},
     Database, Journal, JournalEntry,
};

use anyhow::Result;
use std::{ fmt::Debug};


#[derive(Debug)]
pub struct OpTraceJournal<Db: Database> {
    /// In fork mode, Foundry stores (`JournaledState`, `Database`) pairs for each fork.
    journaled_state: Journal<Db>,
}

impl<Db: Database> OpTraceJournal<Db> {
    pub fn new(spec_id: SpecId, db: Db) -> Self {
        let mut journaled_state = Journal::new(db);
        journaled_state.set_spec_id(spec_id);
        Self { journaled_state }
    }

    pub fn with_journaled_state(&self) -> &Journal<Db> {
        &self.journaled_state
    }
}

impl<Db: Database + 'static> JournalTr for OpTraceJournal<Db> {
    type Database = Db;
    type State = EvmState;
    type JournaledAccount<'a> = JournaledAccount<'a, Db, JournalEntry>;

    fn new(database: Db) -> Self {
        Self::new(SpecId::default(), database)
    }

    fn db(&self) -> &Self::Database {
        self.journaled_state.db()
    }

    fn db_mut(&mut self) -> &mut Self::Database {
        self.journaled_state.db_mut()
    }

    fn sload(
        &mut self,
        address: Address,
        key: StorageKey,
    ) -> Result<StateLoad<StorageValue>, <Self::Database as Database>::Error> {
        self.journaled_state.sload(address, key)
    }

    fn sstore(
        &mut self,
        address: Address,
        key: StorageKey,
        value: StorageValue,
    ) -> Result<StateLoad<SStoreResult>, <Self::Database as Database>::Error> {
        self.journaled_state.sstore(address, key, value)
    }

    fn tload(&mut self, address: Address, key: StorageKey) -> StorageValue {
        self.journaled_state.tload(address, key)
    }

    fn tstore(&mut self, address: Address, key: StorageKey, value: StorageValue) {
        self.journaled_state.tstore(address, key, value)
    }

    fn log(&mut self, log: Log) {
        self.journaled_state.log(log)
    }

    fn logs(&self) -> &[Log] {
        self.journaled_state.logs()
    }

    fn selfdestruct(
        &mut self,
        address: Address,
        target: Address,
        skip_cold_load: bool,
    ) -> Result<StateLoad<SelfDestructResult>, JournalLoadError<<Self::Database as Database>::Error>>
    {
        self.journaled_state
            .selfdestruct(address, target, skip_cold_load)
    }

    fn warm_access_list(&mut self, access_list: AddressMap<HashSet<StorageKey>>) {
        self.journaled_state.warm_access_list(access_list);
    }

    fn warm_coinbase_account(&mut self, address: Address) {
        self.journaled_state.warm_coinbase_account(address)
    }

    fn warm_precompiles(&mut self, addresses: AddressSet) {
        self.journaled_state.warm_precompiles(addresses)
    }

    fn precompile_addresses(&self) -> &AddressSet {
        self.journaled_state.precompile_addresses()
    }

    fn set_spec_id(&mut self, spec_id: SpecId) {
        self.journaled_state.set_spec_id(spec_id);
    }

    fn touch_account(&mut self, address: Address) {
        self.journaled_state.touch_account(address);
    }

    fn transfer(
        &mut self,
        from: Address,
        to: Address,
        balance: U256,
    ) -> Result<Option<TransferError>, <Self::Database as Database>::Error> {
        self.journaled_state.transfer(from, to, balance)
    }

    fn transfer_loaded(
        &mut self,
        from: Address,
        to: Address,
        balance: U256,
    ) -> Option<TransferError> {
        self.journaled_state.transfer_loaded(from, to, balance)
    }

    fn load_account(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<&Account>, <Self::Database as Database>::Error> {
        self.journaled_state.load_account(address)
    }

    fn load_account_with_code(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<&Account>, <Self::Database as Database>::Error> {
        self.journaled_state.load_account_with_code(address)
    }

    fn load_account_delegated(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<AccountLoad>, <Self::Database as Database>::Error> {
        self.journaled_state.load_account_delegated(address)
    }

    fn set_code_with_hash(&mut self, address: Address, code: Bytecode, hash: B256) {
        self.journaled_state.set_code_with_hash(address, code, hash);
    }

    fn code(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<revm::primitives::Bytes>, <Self::Database as Database>::Error> {
        self.journaled_state.code(address)
    }

    fn code_hash(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<B256>, <Self::Database as Database>::Error> {
        self.journaled_state.code_hash(address)
    }

    fn clear(&mut self) {
        self.journaled_state.clear();
    }

    fn checkpoint(&mut self) -> JournalCheckpoint {
        self.journaled_state.checkpoint()
    }

    fn checkpoint_commit(&mut self) {
        self.journaled_state.checkpoint_commit()
    }

    fn checkpoint_revert(&mut self, checkpoint: JournalCheckpoint) {
        self.journaled_state.checkpoint_revert(checkpoint)
    }

    fn create_account_checkpoint(
        &mut self,
        caller: Address,
        address: Address,
        balance: U256,
        spec_id: SpecId,
    ) -> Result<JournalCheckpoint, TransferError> {
        self.journaled_state
            .create_account_checkpoint(caller, address, balance, spec_id)
    }

    /// Returns call depth.
    #[inline]
    fn depth(&self) -> usize {
        self.journaled_state.depth()
    }

    fn finalize(&mut self) -> Self::State {
        self.journaled_state.finalize()
    }

    fn caller_accounting_journal_entry(
        &mut self,
        address: Address,
        old_balance: U256,
        bump_nonce: bool,
    ) {
        self.journaled_state
            .caller_accounting_journal_entry(address, old_balance, bump_nonce)
    }

    fn balance_incr(
        &mut self,
        address: Address,
        balance: U256,
    ) -> Result<(), <Self::Database as Database>::Error> {
        self.journaled_state.balance_incr(address, balance)
    }

    fn nonce_bump_journal_entry(&mut self, address: Address) {
        self.journaled_state.nonce_bump_journal_entry(address)
    }

    fn take_logs(&mut self) -> Vec<Log> {
        self.journaled_state.take_logs()
    }

    fn commit_tx(&mut self) {
        self.journaled_state.commit_tx()
    }

    fn discard_tx(&mut self) {
        self.journaled_state.discard_tx()
    }

    fn sload_skip_cold_load(
        &mut self,
        address: Address,
        key: StorageKey,
        skip_cold_load: bool,
    ) -> Result<StateLoad<StorageValue>, JournalLoadError<<Self::Database as Database>::Error>>
    {
        self.journaled_state
            .sload_skip_cold_load(address, key, skip_cold_load)
    }

    fn sstore_skip_cold_load(
        &mut self,
        address: Address,
        key: StorageKey,
        value: StorageValue,
        skip_cold_load: bool,
    ) -> Result<StateLoad<SStoreResult>, JournalLoadError<<Self::Database as Database>::Error>>
    {
        self.journaled_state
            .sstore_skip_cold_load(address, key, value, skip_cold_load)
    }

    fn load_account_info_skip_cold_load(
        &mut self,
        address: Address,
        load_code: bool,
        skip_cold_load: bool,
    ) -> Result<AccountInfoLoad<'_>, JournalLoadError<<Self::Database as Database>::Error>> {
        self.journaled_state
            .load_account_info_skip_cold_load(address, load_code, skip_cold_load)
    }

    fn load_account_mut_optional_code(
        &mut self,
        address: Address,
        load_code: bool,
    ) -> Result<StateLoad<Self::JournaledAccount<'_>>, <Self::Database as Database>::Error> {
        self.journaled_state
            .load_account_mut_optional_code(address, load_code)
    }

    fn load_account_mut_skip_cold_load(
        &mut self,
        address: Address,
        skip_cold_load: bool,
    ) -> Result<StateLoad<Self::JournaledAccount<'_>>, <Self::Database as Database>::Error> {
        self.journaled_state
            .load_account_mut_skip_cold_load(address, skip_cold_load)
    }
    fn set_eip7708_config(&mut self, disabled: bool, delayed_burn_disabled: bool) {
        self.journaled_state
            .set_eip7708_config(disabled, delayed_burn_disabled);
    }
}

impl<Db: Database + 'static> JournalExt for OpTraceJournal<Db> {
    fn journal(&self) -> &[JournalEntry] {
        self.journaled_state.journal()
    }

    fn evm_state(&self) -> &EvmState {
        self.journaled_state.evm_state()
    }

    fn evm_state_mut(&mut self) -> &mut EvmState {
        self.journaled_state.evm_state_mut()
    }
}
