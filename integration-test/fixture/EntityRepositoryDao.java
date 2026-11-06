package demo;

@Repository("entityRepository")
public class EntityRepositoryDao extends HibernateDaoSupport implements EntityRepository {

    public boolean contains(Object object) {
        return true;
    }

    public Object load(Object object, Long id) {
        return null;
    }

    public void merge(Object object) {
    }

    public void lock(Object object) {
    }

    public Object get(Class clazz, Long id) {
        return null;
    }

    public void flush() {
    }

    public void create(Object object) {
    }

    private void helper() {
    }
}
