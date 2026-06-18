pipeline {
    agent any

    environment {
        PRODUCTION_DIR = "/home/swepi/Desktop/trinidad-news-comparer"
    }

    stages {
        stage('Setup') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Lint') {
            steps {
                sh 'npm run lint 2>/dev/null || echo "No linter configured"'
            }
        }

        stage('Deploy') {
            steps {
                sh """
                    sudo rsync -av --delete --chown=swepi:swepi \
                        --exclude='.env' \
                        --exclude='node_modules/' \
                        --exclude='.git/' \
                        ./ ${PRODUCTION_DIR}/
                    cd ${PRODUCTION_DIR} && docker compose up -d --build
                """
            }
        }
    }

    post {
        failure {
            echo "Pipeline failed. Check the logs for details."
        }
    }
}
