/**
 * OpenACH API Connection Test
 * Run: OPENACH_API_TOKEN=xxx OPENACH_API_KEY=yyy node test-api.js
 * 
 * Tests full flow: connect → getPaymentTypes → disconnect
 */

require('dotenv').config({ path: '../../../.env' });
const { OpenACHClient, OpenACHSession } = require('./openachClient');

async function runTests() {
  console.log('===========================================');
  console.log(' OpenACH API Integration Test');
  console.log(' Base URL:', process.env.OPENACH_BASE_URL || 'https://ach.dlbtrust.cloud/openach/api');
  console.log('===========================================\n');

  if (!process.env.OPENACH_API_TOKEN || !process.env.OPENACH_API_KEY) {
    console.error('❌ ERROR: OPENACH_API_TOKEN and OPENACH_API_KEY must be set');
    console.error('   Run: OPENACH_API_TOKEN=xxx OPENACH_API_KEY=yyy node test-api.js');
    process.exit(1);
  }

  // Test 1: Connect
  console.log('Test 1: Connect to OpenACH API...');
  const session = new OpenACHSession();
  try {
    await session.connect();
    console.log('✅ Connected! Session ID:', session.sessionId);
  } catch (err) {
    console.error('❌ Connect failed:', err.message);
    process.exit(1);
  }

  // Test 2: Get Payment Types
  console.log('\nTest 2: Get Payment Types...');
  try {
    const res = await session.request('getPaymentTypes');
    if (res.success === false) throw new Error(res.error);
    console.log('✅ Payment Types:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('❌ getPaymentTypes failed:', err.message);
  }

  // Test 3: Disconnect
  console.log('\nTest 3: Disconnect...');
  try {
    await session.disconnect();
    console.log('✅ Disconnected cleanly');
  } catch (err) {
    console.warn('⚠️  Disconnect warning:', err.message);
  }

  // Test 4: Full disbursement client test (getPaymentTypes via client)
  console.log('\nTest 4: High-level client getPaymentTypes...');
  try {
    const types = await OpenACHClient.getPaymentTypes();
    console.log('✅ Payment types via client:', JSON.stringify(types, null, 2));
    
    if (Array.isArray(types) && types.length > 0) {
      const trustDist = types.find(t => 
        t.payment_type_name?.toLowerCase().includes('trust') ||
        t.payment_type_name?.toLowerCase().includes('dist')
      );
      if (trustDist) {
        console.log('\n✅ Found Trust Dist payment type:');
        console.log('   payment_type_id:', trustDist.payment_type_id);
        console.log('   payment_type_name:', trustDist.payment_type_name);
        console.log('   Set this as OPENACH_PAYMENT_TYPE_ID in your .env');
      }
    }
  } catch (err) {
    console.error('❌ High-level client test failed:', err.message);
  }

  console.log('\n===========================================');
  console.log(' All tests complete');
  console.log('===========================================');
}

runTests().catch(console.error);
