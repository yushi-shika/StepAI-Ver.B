import { execSync } from 'child_process';
import fs from 'fs';

console.log('Generating self-signed SSL certificates for localhost...');

try {
  // Generate private key
  execSync('openssl genrsa -out localhost-key.pem 2048', { stdio: 'inherit' });

  // Generate certificate
  execSync(`openssl req -new -x509 -key localhost-key.pem -out localhost.pem -days 365 -subj "/C=JP/ST=Tokyo/L=Tokyo/O=Dev/OU=Dev/CN=localhost"`, { stdio: 'inherit' });

  console.log('✅ SSL certificates generated successfully!');
  console.log('  - localhost-key.pem (private key)');
  console.log('  - localhost.pem (certificate)');
  console.log('\nTo use HTTPS:');
  console.log('  HTTPS=true npm start');

} catch (error) {
  console.error('❌ Failed to generate SSL certificates:', error.message);
  console.log('\nAlternative: You can still use HTTP mode:');
  console.log('  npm start');
}